// The server side of client reconnection. The browser client reconnects with
// backoff and re-joins; this asserts the contract that makes that safe:
//   1. an abrupt drop is announced to the room (so others clean up)
//   2. re-joining on a fresh socket restores membership exactly once
//   3. a close arriving late for the socket a peer already replaced does NOT
//      evict it — the laptop-sleep case, where the old socket dies quietly and
//      the server only learns about it after the client is back
//   4. state re-announced on re-join reaches the room
import { RUN_ID, done, ok, signalClient, sleep } from './lib.mjs'

const ROOM = 'reconnect-' + RUN_ID

const bob = signalClient('bob', 'Bob')
await bob.join(ROOM)
await bob.next('room-state')

// --- 1. An abrupt drop is announced.
const aliceOld = signalClient('alice', 'Alice')
await aliceOld.join(ROOM)
await bob.next('peer-joined')

aliceOld.ws.close()
ok((await bob.next('peer-left')).from === 'alice',
  'an abrupt disconnect is announced to the room')
await bob.next('room-state')

// --- 2. Re-joining on a fresh socket restores membership.
const alice = signalClient('alice', 'Alice')
const peers = await alice.join(ROOM)
ok(peers.payload.map((p) => p.id).includes('bob'), 're-join returns the current membership')
ok((await bob.next('peer-joined')).from === 'alice', 'the room is told the peer is back')

const checker = signalClient('checker', 'Checker')
const seen = (await checker.join(ROOM)).payload.map((p) => p.id).sort()
ok(JSON.stringify(seen) === JSON.stringify(['alice', 'bob']),
  `the returning peer appears exactly once (${seen.join(',')})`)
checker.close()
await alice.next('peer-joined')
await bob.next('peer-joined')

// --- 3. A late close for the replaced socket must not evict the live one.
//        Simulated by joining as 'alice' on a third socket (as a reconnect
//        would) and then closing the one it superseded.
const aliceReplaced = signalClient('alice', 'Alice')
await aliceReplaced.join(ROOM)
await sleep(300)
alice.ws.close() // the socket that was just superseded
await sleep(1000)

const after = signalClient('after', 'After')
const stillThere = (await after.join(ROOM)).payload.map((p) => p.id).sort()
ok(stillThere.includes('alice'),
  `the reconnected peer survives the stale close (${stillThere.join(',')})`)

// --- 4. State replayed after a re-join reaches the room.
aliceReplaced.send({ type: 'state', room: ROOM, from: 'alice', payload: { audio: false, video: true } })
const state = await bob.next('state')
ok(state.from === 'alice' && state.payload.audio === false,
  'media state re-announced after reconnect reaches the room')

;[bob, alice, aliceReplaced, after].forEach((c) => c.close())
done('RECONNECT')
