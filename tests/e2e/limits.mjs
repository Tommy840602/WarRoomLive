// Abuse limits on the signaling plane and the HTTP API. The CRDT plane has
// carried message-rate, update-size and document-size limits from the start;
// these are the matching ones for the other two. What matters is containment: a
// misbehaving caller loses its own excess traffic without costing anyone else
// the room.
import { ORIGIN, RUN_ID, WS_ORIGIN, done, ok, signalClient, sleep } from './lib.mjs'

const ROOM = 'limits-' + RUN_ID
const CHAT_LIMIT = Number(process.env.E2E_CHAT_MAX_LENGTH ?? 4000)
const RATE = Number(process.env.E2E_MAX_MESSAGES_PER_SECOND ?? 60)
const API_RATE = Number(process.env.E2E_API_MAX_REQUESTS_PER_SECOND ?? 20)

const alice = signalClient('alice', 'Alice')
await alice.join(ROOM)
await alice.next('room-state')
const bob = signalClient('bob', 'Bob')
await bob.join(ROOM)
await bob.next('room-state')
await alice.next('peer-joined')

// --- Chat length: rejected outright, never silently truncated.
alice.send({ type: 'chat', room: ROOM, from: 'alice', payload: 'x'.repeat(CHAT_LIMIT + 1) })
const rejected = await alice.next('error')
ok(String(rejected.payload).includes('exceeds'),
  `an over-long chat message is refused with a reason (${rejected.payload})`)

alice.send({ type: 'chat', room: ROOM, from: 'alice', payload: 'normal message' })
ok((await bob.next('chat')).payload === 'normal message',
  'a message within the limit still goes through')
ok(!bob.seen('chat', (m) => String(m.payload).startsWith('xxx')),
  'the over-long message never reached the room')

// --- A frame far beyond the container cap: the connection is dropped rather
//     than the server buffering it. Other participants are unaffected.
const huge = signalClient('huge', 'Huge')
await huge.join(ROOM)
await huge.next('room-state')
huge.send({ type: 'chat', room: ROOM, from: 'huge', payload: 'y'.repeat(200_000) })
const closed = await huge.awaitClose(10000).catch(() => null)
ok(closed !== null, `an oversized frame closes only that connection (code ${closed?.code})`)
ok(alice.ws.readyState === WebSocket.OPEN && bob.ws.readyState === WebSocket.OPEN,
  'the other participants are untouched by it')

// --- Rate limit: a flood loses its excess, keeps its connection, and leaves
//     the room usable.
const flooder = signalClient('flooder', 'Flooder')
await flooder.join(ROOM)
await flooder.next('room-state')
await alice.next('peer-joined')
await bob.next('peer-joined')

// Send far more than the bucket can ever pass in the measurement window, so the
// bound is sharp. `send` only queues locally, so the server sees the flood
// spread over the whole window — the ceiling is measured against that, not
// against how long the loop took.
const sent = RATE * 20
const before = bob.inboxSize('chat')
const started = Date.now()
for (let i = 0; i < sent; i++) {
  flooder.send({ type: 'chat', room: ROOM, from: 'flooder', payload: 'spam-' + i })
}
await sleep(2500)
const windowSeconds = (Date.now() - started) / 1000
const delivered = bob.inboxSize('chat') - before

// The contract is a token bucket: at most the burst allowance (2×rate) plus
// whatever refilled during the window. Asserting the actual formula — rather
// than a round number — keeps this meaningful if the rate is ever retuned.
const ceiling = Math.ceil((RATE * 2 + RATE * windowSeconds) * 1.15)
ok(delivered > 0 && delivered <= ceiling,
  `the flood is bounded by the bucket (${delivered} of ${sent} delivered, `
  + `ceiling ${ceiling} over ${windowSeconds.toFixed(1)}s)`)
ok(delivered < sent / 2, `the great majority of the flood was dropped (${delivered} of ${sent})`)
ok(flooder.ws.readyState === WebSocket.OPEN,
  'throttling drops messages without disconnecting the sender')

const marker = 'still-working-' + RUN_ID
alice.send({ type: 'chat', room: ROOM, from: 'alice', payload: marker })
await bob.until('chat', (m) => m.payload === marker, 8000)
ok(true, 'the room keeps working for everyone else during the flood')

// --- The HTTP API carries the same shape of limit. It is the side with the
//     expensive operations (signing tokens and playback URLs, running full-text
//     queries), so a loop over any of them costs far more to serve than to send.
const burst = API_RATE * 6
const statuses = await Promise.all(Array.from({ length: burst }, () =>
  fetch(`${ORIGIN}/api/media/config`).then((r) => r.status).catch(() => 0)))
const throttled = statuses.filter((s) => s === 429).length
ok(throttled > 0, `an API flood is throttled (${throttled} of ${burst} got 429)`)
ok(statuses.filter((s) => s === 200).length >= API_RATE,
  'and the burst allowance was served first, so ordinary use is untouched')

// Health must stay answerable even while a caller is being throttled — it is
// what tells an operator the service is alive.
ok((await fetch(`${ORIGIN}/api/health`)).ok, 'health is exempt and still answers')

// The bucket refills, so a throttled caller recovers on its own.
await sleep(2000)
ok((await fetch(`${ORIGIN}/api/media/config`)).ok, 'the caller recovers once the bucket refills')

;[alice, bob, flooder].forEach((c) => c.close())
done('LIMITS')
