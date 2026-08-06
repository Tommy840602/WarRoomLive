// Chaos suite (Toxiproxy): injects latency and abrupt connection cuts between a
// client and the signaling backend, and asserts graceful behavior — delivery
// under latency, clean membership teardown on a cut, immediate rejoin.
//
// Run via tests/chaos/run.sh (starts Toxiproxy, wires the proxy, executes this
// with Node ≥22 on the host). TOXI_API / TOXI_WS / DIRECT_WS are provided by it.
const TOXI_API = process.env.TOXI_API ?? 'http://localhost:8474'
const TOXI_WS = process.env.TOXI_WS ?? 'ws://localhost:18081/ws/signal'
const DIRECT_WS = process.env.DIRECT_WS ?? 'ws://localhost:8088/ws/signal'
const ROOM = 'chaos-' + (process.argv[2] ?? 'run')

let passed = 0
const ok = (cond, label) => {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1) }
  console.log('ok: ' + label); passed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (method, path, body) =>
  fetch(TOXI_API + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

/** Minimal signaling client: join + typed waits + chat RTT measurement hooks. */
function client(url, id, name) {
  const ws = new WebSocket(url)
  const queue = []
  const waiters = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const i = waiters.findIndex((w) => w.type === msg.type)
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
    else queue.push(msg)
  }
  const next = (type, ms = 8000) =>
    new Promise((resolve, reject) => {
      const qi = queue.findIndex((m) => m.type === type)
      if (qi >= 0) return resolve(queue.splice(qi, 1)[0])
      const t = setTimeout(() => reject(new Error(`timeout waiting ${type} on ${id}`)), ms)
      waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m) } })
    })
  const join = async () => {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connect failed')) })
    ws.send(JSON.stringify({ type: 'join', room: ROOM, from: id, payload: name }))
    return next('peers')
  }
  const send = (m) => ws.send(JSON.stringify(m))
  return { ws, id, join, next, send }
}

// --- Baseline: A rides through Toxiproxy, B connects directly.
await api('POST', '/reset')
const a = client(TOXI_WS, 'alice', 'Alice')
await a.join()
const b = client(DIRECT_WS, 'bob', 'Bob')
await b.join()
await a.next('peer-joined')
ok(true, 'A (via toxiproxy) and B (direct) share the room')

const rtt = async (label) => {
  const t0 = Date.now()
  a.send({ type: 'chat', room: ROOM, from: 'alice', payload: label + ':' + t0 })
  await b.next('chat', 15000)
  return Date.now() - t0
}
const base = []
for (let i = 0; i < 5; i++) base.push(await rtt('base'))
const baseAvg = base.reduce((s, v) => s + v, 0) / base.length
ok(baseAvg < 100, `baseline chat delivery avg ${baseAvg.toFixed(1)}ms`)

// --- Latency injection: +200ms upstream on A's path; delivery continues, shifted.
await api('POST', '/proxies/signal/toxics', {
  name: 'lag', type: 'latency', stream: 'upstream', attributes: { latency: 200, jitter: 20 },
})
const laggy = []
for (let i = 0; i < 5; i++) laggy.push(await rtt('lag'))
const lagAvg = laggy.reduce((s, v) => s + v, 0) / laggy.length
ok(laggy.length === 5, 'all 5 chats delivered under 200ms injected latency (no loss)')
ok(lagAvg > baseAvg + 150, `delivery latency shifted by the injected amount (${baseAvg.toFixed(1)}ms → ${lagAvg.toFixed(1)}ms)`)
await api('DELETE', '/proxies/signal/toxics/lag')

// --- Abrupt cut: disable the proxy; B must see peer-left, A can rejoin directly.
await api('POST', '/proxies/signal', { enabled: false })
const left = await b.next('peer-left', 20000)
ok(left.from === 'alice', 'survivor received peer-left after the network cut')

const a2 = client(DIRECT_WS, 'alice', 'Alice')
const peers = await a2.join()
ok(peers.payload.length === 1 && peers.payload[0].id === 'bob',
  'cut peer rejoined immediately and sees a clean membership (no ghost of itself)')
const t0 = Date.now()
a2.send({ type: 'chat', room: ROOM, from: 'alice', payload: 'back:' + t0 })
await b.next('chat')
ok(true, 'chat flows again after recovery')

a2.ws.close(); b.ws.close()
await api('POST', '/proxies/signal', { enabled: true })
console.log(`\nALL ${passed} CHAOS CHECKS PASSED (room=${ROOM})`)
process.exit(0)
