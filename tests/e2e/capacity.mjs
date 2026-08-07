// The room cap must hold under simultaneous joins, not just sequential ones:
// 12 clients race into a cap-8 room and the split must be exactly 8/4. On the
// scale stack the joins land on different backends, so this exercises the
// Redis Lua path (count + conditional write in one atomic step).
import { RUN_ID, WS_ORIGIN, discoverRoomCap, done, ok } from './lib.mjs'

const ROOM = 'cap-' + RUN_ID
// The cap is configuration (8 by default, 50 under the SFU overlay), so it is
// read from the running stack — a hard-coded number turns this into a test of
// which overlay happens to be up.
const CAP = Number(process.env.E2E_ROOM_CAP ?? await discoverRoomCap())
const ATTEMPTS = CAP + 4

const attempt = (i) => new Promise((resolve) => {
  const ws = new WebSocket(`${WS_ORIGIN}/ws/signal`)
  ws.onopen = () => ws.send(JSON.stringify({
    type: 'join', room: ROOM, from: 'p' + i, payload: 'P' + i,
  }))
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'peers') resolve({ ws, outcome: 'accepted' })
    else if (msg.type === 'room-full') resolve({ ws, outcome: 'rejected' })
  }
  ws.onerror = () => resolve({ ws, outcome: 'error' })
  setTimeout(() => resolve({ ws, outcome: 'timeout' }), 10000)
})

const results = await Promise.all(Array.from({ length: ATTEMPTS }, (_, i) => attempt(i)))
const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {})
console.log('   outcomes: ' + JSON.stringify(counts))

ok(counts.accepted === CAP && counts.rejected === ATTEMPTS - CAP,
  `exactly ${CAP} accepted and ${ATTEMPTS - CAP} rejected under concurrent joins`)

results.forEach((r) => r.ws.close())
done('CAPACITY')
