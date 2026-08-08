// Due reminders: the agenda telling the room when something's time has come.
//
//   docker compose up -d
//   tests/e2e/run.sh due
//
// Slow by nature — the sweep runs on a timer — and worth it, because the two
// properties are exactly the ones a scheduler gets wrong: that it fires at all,
// and that it fires *once*. The second is what `reminded_at` is for; without
// it a restart replays everything and two nodes each say it separately.
import { ORIGIN, RUN_ID, done, ok, signalClient } from './lib.mjs'

const ROOM = 'due-' + RUN_ID

const api = (m, p, b) => fetch(`${ORIGIN}${p}`, { method: m,
  headers: { 'content-type': 'application/json' },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }) })

const watcher = signalClient('w-' + Date.now(), 'Watcher')
await watcher.opened
watcher.send({ type: 'join', room: ROOM, from: watcher.id, payload: 'Watcher' })
await watcher.next('peers')

// Already past: the sweep should pick it up on its next pass.
const past = new Date(Date.now() - 60_000).toISOString()
const created = await (await api('POST', `/api/todos/${ROOM}`, { text: '該做了', assignee: 'bob', dueAt: past })).json()

const msg = await watcher.next('agenda-due', 90_000)
ok(msg.payload?.id === created.id, `the room is told when something comes due (${msg.payload?.text})`)
ok(msg.payload?.assignee === 'bob', 'with who it belongs to')

// Exactly once: a second pass must not repeat it.
let repeated = false
try { await watcher.next('agenda-due', 75_000); repeated = true } catch { /* expected */ }
ok(!repeated, 'and told exactly once, not again on the next pass')
watcher.close()
done('DUE-REMINDER')
