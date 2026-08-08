// A room's own history, and what it leaves behind.
//
//   docker compose up -d
//   tests/e2e/run.sh meetings
//
// The `meetings` table had been written since the meeting domain landed and
// nothing ever read a row, so a room could not answer "when did we last meet,
// and for how long" about itself — and nothing carried away what happened.
// These are the properties that matter: a meeting exists because somebody was
// in the room, its duration becomes a fact only when it ends, the record
// really contains the other planes' contents, and a meeting belongs to its
// room rather than to whoever knows its id.
import { ORIGIN, RUN_ID, done, ok, signalClient } from './lib.mjs'

const ROOM = 'meetings-' + RUN_ID

const api = (m, p, b) => fetch(`${ORIGIN}${p}`, { method: m,
  headers: { 'content-type': 'application/json' },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }) })
const json = (r) => r.json()

// --- A meeting exists only once somebody has been in the room.
let list = await json(await fetch(`${ORIGIN}/api/meetings/${ROOM}`))
ok(list.length === 0, 'a room with no history lists no meetings')

const alice = signalClient('alice-' + Date.now(), 'Alice')
await alice.opened
alice.send({ type: 'join', room: ROOM, from: alice.id, payload: 'Alice' })
await alice.next('peers')
list = await json(await fetch(`${ORIGIN}/api/meetings/${ROOM}`))
ok(list.length === 1, `joining opens a meeting (${list.length})`)
ok(list[0].live === true && list[0].endedAt === undefined,
  'and it is reported live rather than given an invented duration')
const meetingId = list[0].id

// --- Things to put in the record.
await api('POST', `/api/todos/${ROOM}`, { text: '記錄裡要看得到這個', assignee: 'bob' })
await api('POST', `/api/calendar/${ROOM}`, { title: '排定的會', startsAt: new Date(Date.now() + 3600_000).toISOString() })
alice.send({ type: 'chat', room: ROOM, from: alice.id, payload: '這句要進紀錄' })
await new Promise((r) => setTimeout(r, 800))

// --- Export.
const res = await fetch(`${ORIGIN}/api/meetings/${ROOM}/${meetingId}/export`)
ok(res.ok, `the record downloads (HTTP ${res.status})`)
ok((res.headers.get('content-disposition') ?? '').includes('attachment'),
  'as an attachment, because people keep these')
const md = await res.text()
ok(md.includes('# ' + ROOM), 'it names the room and when it ran')
ok(md.includes('這句要進紀錄'), 'the chat is in it')
ok(md.includes('記錄裡要看得到這個') && md.includes('@bob'), 'so is the agenda, with owners')
ok(md.includes('排定的會'), 'and the calendar')
ok(md.includes('共同筆記'), 'the notes have a section even when empty')
ok(!md.includes('讀不到筆記'), 'and the collab service answered')

// --- A meeting belongs to its room. Asking for it under another room's name
//     must not hand it over, or the room in the path is decoration.
const other = await fetch(`${ORIGIN}/api/meetings/${ROOM}-somewhere-else/${meetingId}/export`)
ok(other.status === 404, `a meeting id from another room is not exportable (HTTP ${other.status})`)

// A room name with characters that would break a Content-Disposition header
// must not reach it intact.
const quoted = await fetch(`${ORIGIN}/api/meetings/${encodeURIComponent('a"b c')}/${meetingId}/export`)
ok(quoted.status === 404, `an unrelated quoted room name is refused (HTTP ${quoted.status})`)

// --- Closing the room closes the meeting.
alice.close()
await new Promise((r) => setTimeout(r, 1500))
list = await json(await fetch(`${ORIGIN}/api/meetings/${ROOM}`))
ok(list[0].live === undefined && typeof list[0].durationSeconds === 'number',
  `leaving closes it and the duration becomes a fact (${list[0].durationSeconds}s)`)
ok(list[0].participantPeak >= 1, 'with the peak it reached')

done('MEETINGS')
