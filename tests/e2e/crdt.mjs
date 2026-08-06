// CRDT plane: two clients converge through the collab service, concurrent and
// offline edits merge without loss, and a late joiner receives full state.
import { RUN_ID, collabClient, done, ok, sleep, until } from './lib.mjs'

const DOC = 'warroom:crdt-' + RUN_ID

const a = await collabClient(DOC)
const b = await collabClient(DOC)

await until('both clients synced', () => a.provider.isSynced && b.provider.isSynced)
ok(true, 'two clients connected and synced through /ws/doc')

a.text.insert(0, 'hello-from-A ')
await until('B sees A', () => b.text.toString().includes('hello-from-A'))
ok(true, "A's edit replicated to B")

b.text.insert(b.text.length, 'hello-from-B')
await until('A sees B', () => a.text.toString().includes('hello-from-B'))
ok(a.text.toString() === b.text.toString(), `documents converged: "${a.text.toString()}"`)

// Concurrent edits at the same position must both survive — the CRDT property
// that makes offline editing safe.
a.provider.disconnect()
a.text.insert(0, '[A-offline]')
b.text.insert(0, '[B-online]')
a.provider.connect()
await until('offline edit merged', () =>
  a.text.toString() === b.text.toString()
  && a.text.toString().includes('[A-offline]')
  && a.text.toString().includes('[B-online]'), 15000)
ok(true, 'concurrent offline edits merged conflict-free on reconnect')

const c = await collabClient(DOC)
await until('late joiner synced', () =>
  c.provider.isSynced && c.text.toString() === a.text.toString())
ok(true, 'a late joiner received the converged document')

await sleep(5000) // let the debounced snapshot reach Postgres before we disconnect
;[a, b, c].forEach((client) => client.destroy())

done('CRDT')
