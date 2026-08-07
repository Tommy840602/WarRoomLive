// The room's shared to-do list and calendar. Needs a database (postgres
// profile), which the base stack has.
//
//   docker compose up -d
//   tests/e2e/run.sh agenda
//
// These are durable business records rather than collaborative text, which is
// why they are here and not in the room's Yjs document. So the things worth
// asserting are the ones a CRDT could not give you: server-owned ordering,
// refusal of bad input, completion recorded as a fact with an author, and the
// room being told so open panels refresh.
import { ORIGIN, RUN_ID, done, ok, signalClient } from './lib.mjs'

const ROOM = 'agenda-' + RUN_ID
const json = (res) => res.json()
const api = (method, path, body) => fetch(`${ORIGIN}${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const hour = 60 * 60 * 1000
const iso = (ms) => new Date(Date.now() + ms).toISOString()

// --- To-do list -----------------------------------------------------------

const created = await api('POST', `/api/todos/${ROOM}`, {
  text: '訂會議室', assignee: 'bob', dueAt: iso(48 * hour),
})
ok(created.ok, `an item is added (HTTP ${created.status})`)
const first = await json(created)
ok(first.done === false && first.assignee === 'bob', 'it starts open, with its assignee')

// Empty text is refused, not stored as a blank row nobody can act on.
const blank = await api('POST', `/api/todos/${ROOM}`, { text: '   ' })
ok(blank.status === 400, `an empty item is refused (HTTP ${blank.status})`)

// A bad date is refused rather than silently dropped — storing "no due date"
// for something the user did set is worse than an error.
const badDate = await api('POST', `/api/todos/${ROOM}`, { text: 'x', dueAt: 'next tuesday' })
ok(badDate.status === 400, `an unparseable due date is refused (HTTP ${badDate.status})`)

// --- Ordering is the server's: open first, then soonest-due.
await api('POST', `/api/todos/${ROOM}`, { text: '寄簡報', dueAt: iso(1 * hour) })
await api('POST', `/api/todos/${ROOM}`, { text: '沒有期限的事' })
let listed = await json(await fetch(`${ORIGIN}/api/todos/${ROOM}`))
ok(listed.map((t) => t.text).join(',') === '寄簡報,訂會議室,沒有期限的事',
  `open items come first, soonest-due first, undated last (${listed.map((t) => t.text)})`)

// --- Completion is a fact with a time and an author, not a flag.
const doneRes = await api('PATCH', `/api/todos/${ROOM}/${first.id}`, { done: true })
const completed = await json(doneRes)
ok(completed.done === true && !!completed.completedAt && !!completed.completedBy,
  `completing records who and when (${completed.completedBy} at ${completed.completedAt})`)

// Both readings come from the database. The value returned inline carries the
// in-memory Instant's nanoseconds, while a re-read carries what timestamptz
// stored (microseconds) — comparing across the two would fail on rounding
// alone and say nothing about whether it was rewritten.
const readTodo = async (id) =>
  (await json(await fetch(`${ORIGIN}/api/todos/${ROOM}`))).find((t) => t.id === id)
const firstCompletedAt = (await readTodo(first.id)).completedAt
await api('PATCH', `/api/todos/${ROOM}/${first.id}`, { done: true })
const again = await readTodo(first.id)
ok(again.completedAt === firstCompletedAt,
  'a second completion does not rewrite who finished it')

// --- A finished item sinks below the open ones.
listed = await json(await fetch(`${ORIGIN}/api/todos/${ROOM}`))
ok(listed[listed.length - 1].id === first.id,
  'a completed item moves below what is still open')

// Reopening is a real transition back.
const reopened = await json(await api('PATCH', `/api/todos/${ROOM}/${first.id}`, { done: false }))
ok(reopened.done === false && !reopened.completedAt, 'reopening clears the completion')

// --- A PATCH says what changed; untouched fields survive.
const edited = await json(await api('PATCH', `/api/todos/${ROOM}/${first.id}`, { text: '訂大會議室' }))
ok(edited.text === '訂大會議室' && edited.assignee === 'bob',
  'a partial update leaves the fields it did not mention alone')

// --- Paging, same contract as every other list endpoint.
const clamped = await json(await fetch(`${ORIGIN}/api/todos/${ROOM}?limit=0&offset=-1`))
ok(clamped.length === 3, 'nonsense paging is clamped rather than turned into an error')

// --- Calendar -------------------------------------------------------------

const soon = iso(2 * hour);
const later = iso(26 * hour)
const meeting = await json(await api('POST', `/api/calendar/${ROOM}`, {
  title: '週會', description: '每週同步', startsAt: soon, endsAt: iso(3 * hour),
}))
ok(meeting.id > 0 && meeting.title === '週會', 'a calendar entry is added')

await api('POST', `/api/calendar/${ROOM}`, { title: '明天的事', startsAt: later })

const backwards = await api('POST', `/api/calendar/${ROOM}`, {
  title: '倒著的', startsAt: iso(5 * hour), endsAt: iso(4 * hour),
})
ok(backwards.status === 400,
  `an entry that ends before it starts is refused (HTTP ${backwards.status})`)

const noStart = await api('POST', `/api/calendar/${ROOM}`, { title: '沒有時間' })
ok(noStart.status === 400, `an entry with no start is refused (HTTP ${noStart.status})`)

// --- The calendar reads forwards from now, soonest first.
const upcoming = await json(await fetch(`${ORIGIN}/api/calendar/${ROOM}`))
ok(upcoming.map((e) => e.title).join(',') === '週會,明天的事',
  `upcoming entries come back soonest first (${upcoming.map((e) => e.title)})`)

// Something already past is not "upcoming" — but is reachable by asking.
await api('POST', `/api/calendar/${ROOM}`, { title: '上週的事', startsAt: iso(-7 * 24 * hour) })
const stillUpcoming = await json(await fetch(`${ORIGIN}/api/calendar/${ROOM}`))
ok(!stillUpcoming.some((e) => e.title === '上週的事'),
  'a past entry is not in the default forward view')
const withPast = await json(
  await fetch(`${ORIGIN}/api/calendar/${ROOM}?from=${encodeURIComponent(iso(-30 * 24 * hour))}`))
ok(withPast.some((e) => e.title === '上週的事'),
  'and is reachable by reading from an earlier point')

// --- The room is told, so open panels refresh without polling -------------

const watcher = signalClient('watcher', 'Watcher')
await watcher.join(ROOM)
await watcher.next('room-state')

await api('POST', `/api/todos/${ROOM}`, { text: '通知測試' })
const todoNotice = await watcher.next('agenda', 10000)
ok(todoNotice.payload?.kind === 'todo',
  `a to-do change is announced to the room (${todoNotice.payload?.kind})`)

await api('POST', `/api/calendar/${ROOM}`, { title: '通知測試', startsAt: iso(4 * hour) })
const calendarNotice = await watcher.until('agenda', (m) => m.payload?.kind === 'calendar', 10000)
ok(calendarNotice.payload?.kind === 'calendar',
  'and so is a calendar change, named separately so only that list refetches')
watcher.close()

// --- Deletion -------------------------------------------------------------

const removed = await api('DELETE', `/api/todos/${ROOM}/${first.id}`)
ok(removed.ok, `an item is deleted (HTTP ${removed.status})`)
const afterDelete = await json(await fetch(`${ORIGIN}/api/todos/${ROOM}`))
ok(!afterDelete.some((t) => t.id === first.id), 'and is gone from the list')
ok((await api('DELETE', `/api/todos/${ROOM}/${first.id}`)).status === 404,
  'deleting it again is a 404, not a second success')

const removedEvent = await api('DELETE', `/api/calendar/${ROOM}/${meeting.id}`)
ok(removedEvent.ok, `a calendar entry is deleted (HTTP ${removedEvent.status})`)

// --- Rooms do not see each other's lists.
const other = await json(await fetch(`${ORIGIN}/api/todos/${ROOM}-other`))
ok(other.length === 0, "another room's list is empty, not this one's")

done('AGENDA')
