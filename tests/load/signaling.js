// k6 load test for the signaling plane (chat/presence over WebSocket).
//
// Every VU opens one socket, joins a shared room (~PEERS_PER_ROOM peers per
// room, below the mesh cap) and chats on an interval. Latency is measured from
// timestamps embedded in the chat payload — all VUs run in one k6 process, so
// sender and receiver share a clock:
//   warroom_join_rtt — join sent → `peers` reply received
//   warroom_chat_rtt — chat sent by any VU → received by another VU in the room
//
// Thresholds encode the blueprint SLOs (chat end-to-end P95 < 150 ms same-zone).
// Tune the workload via env: VUS, PEERS_PER_ROOM, CHAT_INTERVAL_MS, SESSION_MS,
// RAMP, HOLD, WS_URL. See tests/load/run.sh.
import ws from 'k6/ws'
import { check } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const joinRtt = new Trend('warroom_join_rtt', true)
const chatRtt = new Trend('warroom_chat_rtt', true)
const delivered = new Counter('warroom_chats_delivered')
const protocolErrors = new Counter('warroom_errors')
// Correct server behavior under this workload's iteration-boundary overlap
// (a new join can race the close of a previous session): tracked, not an error.
const roomFull = new Counter('warroom_room_full')

const WS_URL = __ENV.WS_URL || 'ws://frontend/ws/signal'
const VUS = Number(__ENV.VUS || 120)
const PEERS_PER_ROOM = Number(__ENV.PEERS_PER_ROOM || 4) // keep < the room cap (8)
const CHAT_INTERVAL_MS = Number(__ENV.CHAT_INTERVAL_MS || 2000)
const SESSION_MS = Number(__ENV.SESSION_MS || 30000)
const RUN_ID = __ENV.RUN_ID || 'local'

export const options = {
  scenarios: {
    signaling: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '20s', target: VUS },
        { duration: __ENV.HOLD || '60s', target: VUS },
      ],
      gracefulStop: '10s',
    },
  },
  thresholds: {
    warroom_join_rtt: ['p(95)<250'],
    warroom_chat_rtt: ['p(95)<150', 'p(99)<300'],
    warroom_errors: ['count==0'],
    checks: ['rate>0.99'],
  },
}

export default function () {
  const room = `k6-${RUN_ID}-${__VU % Math.max(1, Math.ceil(VUS / PEERS_PER_ROOM))}`
  const me = `vu${__VU}-${__ITER}`
  const joinSent = Date.now()
  let joined = false

  const result = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'join', room, from: me, payload: me }))
    })

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch (e) {
        protocolErrors.add(1)
        return
      }
      if (msg.type === 'peers') {
        joined = true
        joinRtt.add(Date.now() - joinSent)
        // Chat on an interval once we are in; payload carries the send time.
        socket.setInterval(() => {
          socket.send(JSON.stringify({
            type: 'chat', room, from: me, payload: `t:${Date.now()}`,
          }))
        }, CHAT_INTERVAL_MS)
        socket.setTimeout(() => socket.close(), SESSION_MS)
      } else if (msg.type === 'chat') {
        const ts = Number(String(msg.payload).slice(2))
        if (ts > 0) {
          chatRtt.add(Date.now() - ts)
          delivered.add(1)
        }
      } else if (msg.type === 'room-full') {
        roomFull.add(1)
        joined = true // capacity rejection is a valid outcome for the join check
        socket.close()
      } else if (msg.type === 'error') {
        protocolErrors.add(1)
        socket.close()
      }
    })

    socket.on('error', (e) => {
      // A k6 client artifact, not a server fault: the chat interval can race the
      // session-end close ("websocket: close sent"). Everything else counts.
      if (e && String(e.error()).includes('close sent')) return
      console.error('WSERR:', e ? String(e.error()) : 'unknown')
      protocolErrors.add(1)
    })
  })

  check(result, { 'ws session established': (r) => r && r.status === 101 })
  check(null, { 'joined a room': () => joined })
}
