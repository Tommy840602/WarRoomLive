// Core signaling plane: peer discovery, the glare asymmetry, point-to-point
// SDP/ICE relay, chat broadcast + history replay, the room cap, and departure
// notices. Runs against any stack shape (base, scale, sfu, …).
import { RUN_ID, discoverRoomCap, done, ok, signalClient, sleep } from './lib.mjs'

const ROOM = 'e2e-' + RUN_ID

// 1. Alice opens an empty room.
const alice = signalClient('alice', 'Alice')
const alicePeers = await alice.join(ROOM)
ok(Array.isArray(alicePeers.payload) && alicePeers.payload.length === 0,
  'alice joins an empty room (peers=[])')

// 2. Bob joins. The newcomer learns the existing peers; the incumbent gets
//    peer-joined — the asymmetry that decides who sends the offer.
const bob = signalClient('bob', 'Bob')
const bobPeers = await bob.join(ROOM)
ok(bobPeers.payload.length === 1 && bobPeers.payload[0].id === 'alice'
  && bobPeers.payload[0].name === 'Alice', 'bob receives peers=[alice/Alice]')
const joined = await alice.next('peer-joined')
ok(joined.from === 'bob' && joined.payload === 'Bob', 'alice receives peer-joined from bob')

// 3. Negotiation traffic is relayed verbatim to the addressed peer only.
alice.send({ type: 'offer', room: ROOM, from: 'alice', to: 'bob', payload: { sdp: 'fake-offer' } })
const offer = await bob.next('offer')
ok(offer.from === 'alice' && offer.payload.sdp === 'fake-offer', 'offer relayed alice→bob')

bob.send({ type: 'answer', room: ROOM, from: 'bob', to: 'alice', payload: { sdp: 'fake-answer' } })
const answer = await alice.next('answer')
ok(answer.from === 'bob' && answer.payload.sdp === 'fake-answer', 'answer relayed bob→alice')

bob.send({ type: 'candidate', room: ROOM, from: 'bob', to: 'alice', payload: { candidate: 'c1' } })
const candidate = await alice.next('candidate')
ok(candidate.payload.candidate === 'c1', 'ICE candidate relayed bob→alice')

// 4. Chat and ephemeral state fan out to the rest of the room.
alice.send({ type: 'chat', room: ROOM, from: 'alice', payload: 'hello from e2e' })
const chat = await bob.next('chat')
ok(chat.from === 'alice' && chat.payload === 'hello from e2e', 'chat broadcast to bob')

bob.send({ type: 'state', room: ROOM, from: 'bob', payload: { audio: true, video: false } })
const state = await alice.next('state')
ok(state.from === 'bob' && state.payload.video === false, 'media state broadcast to alice')

// 5. A later joiner gets the room's persisted chat replayed.
await sleep(300) // let the write settle
const carol = signalClient('carol', 'Carol')
const carolPeers = await carol.join(ROOM)
ok(carolPeers.payload.length === 2, 'carol receives peers=[alice,bob]')
const history = await carol.next('history')
ok(history.payload.some((m) => m.fromId === 'alice' && m.text === 'hello from e2e' && m.name === 'Alice'),
  'carol receives the chat history replayed from the repository')

// 6. Fill the room to its cap; the next join bounces with room-full. The cap is
//    configuration (8 by default, 50 under the SFU overlay), so it is read from
//    the running stack rather than assumed.
const cap = await discoverRoomCap()
const extras = []
for (let i = carolPeers.payload.length + 1; i < cap; i++) {
  const extra = signalClient('extra' + i, 'Extra' + i)
  await extra.join(ROOM)
  extras.push(extra)
}
const overflow = signalClient('overflow', 'Overflow')
await overflow.opened
overflow.send({ type: 'join', room: ROOM, from: 'overflow', payload: 'Overflow' })
const full = await overflow.next('room-full')
ok(full.payload === cap, `the join past the cap is rejected with room-full (cap ${cap})`)

// 7. A dropped connection is announced to the rest of the room.
bob.close()
const left = await alice.next('peer-left')
ok(left.from === 'bob', 'alice receives peer-left after bob disconnects')
;[alice, carol, overflow, ...extras].forEach((c) => c.close())

done('SIGNALING')
