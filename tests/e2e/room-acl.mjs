// Room access control: host assignment and handover, host-only lock and kick,
// and the two refusals that matter — a non-host acting, and a peer claiming
// someone else's identity. On the scale stack the peers land on different
// backend replicas (nginx round-robin), so this also covers cross-node kicks.
import { RUN_ID, done, ok, signalClient } from './lib.mjs'

const ROOM = 'acl-' + RUN_ID

// --- Host assignment: the peer that opens the room hosts it.
const alice = signalClient('alice', 'Alice')
await alice.join(ROOM)
const aliceState = await alice.next('room-state')
ok(aliceState.payload.host === 'alice' && aliceState.payload.locked === false,
  'the peer that opens the room becomes host (unlocked)')

const bob = signalClient('bob', 'Bob')
await bob.join(ROOM)
const bobState = await bob.next('room-state')
ok(bobState.payload.host === 'alice', 'a joiner is told who currently hosts')
await alice.next('peer-joined')

// --- Enforcement: privileged actions are refused for non-hosts, and a peer
//     cannot act as an identity it did not join as.
bob.send({ type: 'lock', room: ROOM, from: 'bob', payload: true })
ok(String((await bob.next('error')).payload).includes('only the host'), 'non-host lock refused')

bob.send({ type: 'lock', room: ROOM, from: 'alice', payload: true })
ok(String((await bob.next('error')).payload).includes('does not match'), 'spoofed-sender lock refused')

bob.send({ type: 'kick', room: ROOM, from: 'alice', to: 'bob' })
ok(String((await bob.next('error')).payload).includes('does not match'), 'spoofed-sender kick refused')

// --- Lock: broadcast to the room, and newcomers bounce.
alice.send({ type: 'lock', room: ROOM, from: 'alice', payload: true })
ok((await alice.next('room-state')).payload.locked === true, 'lock reaches the acting host')
ok((await bob.next('room-state')).payload.locked === true, 'lock is broadcast to the room')

const bounced = signalClient('carol', 'Carol')
await bounced.opened
bounced.send({ type: 'join', room: ROOM, from: 'carol', payload: 'Carol' })
await bounced.next('room-locked')
ok(true, 'a newcomer is rejected from the locked room (room-locked)')
bounced.close()

// An existing member reconnecting passes the lock — locks keep strangers out,
// they do not strand participants who drop.
alice.send({ type: 'join', room: ROOM, from: 'alice', payload: 'Alice' })
await alice.next('peers')
ok((await alice.next('room-state')).payload.locked === true,
  'an existing member re-registers through the lock')

// --- Unlock re-admits.
alice.send({ type: 'lock', room: ROOM, from: 'alice', payload: false })
await alice.next('room-state')
await bob.next('room-state')
const carol = signalClient('carol', 'Carol')
await carol.join(ROOM)
await carol.next('room-state')
ok(true, 'unlocking re-admits newcomers')
await alice.next('peer-joined')
await bob.next('peer-joined')

// --- Kick: the target is told, then disconnected with 4403; the room sees it leave.
alice.send({ type: 'kick', room: ROOM, from: 'alice', to: 'carol' })
ok((await carol.next('kicked')).payload === 'alice', 'the kicked peer is told which host removed it')
ok((await carol.awaitClose()).code === 4403, 'the kicked connection is closed with 4403')
ok((await bob.next('peer-left')).from === 'carol', 'the room is told the kicked peer left')
await bob.next('room-state')
await alice.next('peer-left')
await alice.next('room-state')

// --- Handover: when the host leaves, a remaining member inherits the role.
alice.close()
await bob.next('peer-left')
ok((await bob.next('room-state')).payload.host === 'bob', 'the host role is handed to a remaining member')

bob.send({ type: 'lock', room: ROOM, from: 'bob', payload: true })
ok((await bob.next('room-state')).payload.locked === true, "the new host's privileges are real")
bob.close()

done('ROOM-ACL')
