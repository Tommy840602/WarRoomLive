// Sentinel failover drill (run by tests/ha/failover-drill.sh against the
// scale+ha stack): establish cross-instance signaling + CRDT traffic, kill the
// Redis master, verify Sentinel promotes the replica and everything resumes.
import { execSync } from 'node:child_process'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const ROOM = 'ha-' + (process.argv[2] ?? 'run')

let passed = 0
const ok = (cond, label) => {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1) }
  console.log('ok: ' + label); passed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (label, fn, ms = 60000, step = 1000) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + label)
    await sleep(step)
  }
}
const masterAddr = () =>
  execSync('docker exec warroomlive-sentinel-1-1 redis-cli -p 26379 sentinel get-master-addr-by-name warroom')
    .toString().trim().replace('\n', ':')

function signalClient(id, name) {
  const ws = new WebSocket('ws://localhost:8088/ws/signal')
  const inbox = []
  ws.onmessage = (ev) => inbox.push(JSON.parse(ev.data))
  const join = () => new Promise((res, rej) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: ROOM, from: id, payload: name }))
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (inbox.some((m) => m.type === 'peers')) { clearInterval(iv); res() }
      else if (Date.now() - t0 > 10000) { clearInterval(iv); rej(new Error(id + ' join timeout')) }
    }, 50)
  })
  const chat = (text) => ws.send(JSON.stringify({ type: 'chat', room: ROOM, from: id, payload: text }))
  const received = (text) => inbox.some((m) => m.type === 'chat' && m.payload === text)
  return { ws, join, chat, received, inbox }
}

function collabClient() {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: 'ws://localhost:8088/ws/doc', name: `warroom:${ROOM}`, document: doc, WebSocketPolyfill: WebSocket,
  })
  return { doc, provider, text: doc.getText('e2e') }
}

// --- Baseline: cross-connection chat + CRDT sync while the original master lives.
const before = masterAddr()
console.log('   master before: ' + before)
const a = signalClient('alice', 'Alice')
await a.join()
const b = signalClient('bob', 'Bob')
await b.join()
a.chat('pre-failover')
await until('baseline chat', () => b.received('pre-failover'), 10000, 100)
ok(true, 'baseline cross-connection chat works (master: ' + before + ')')

const c1 = collabClient()
const c2 = collabClient()
await until('collab synced', () => c1.provider.isSynced && c2.provider.isSynced, 15000, 100)
c1.text.insert(0, 'pre ')
await until('collab baseline', () => c2.text.toString().includes('pre '), 10000, 100)
ok(true, 'baseline CRDT sync works across collab instances')

// --- Kill the master. Sentinels must promote the replica.
console.log('   killing redis master...')
execSync('docker kill warroomlive-redis-1')
await until('sentinel promoted a new master', () => {
  try { return masterAddr() !== before && masterAddr().includes('redis-replica') } catch { return false }
}, 60000)
ok(true, 'sentinel promoted the replica (master now: ' + masterAddr() + ')')

// --- Recovery: existing connections keep working, new joins succeed.
await until('chat resumes after failover', () => {
  a.chat('post-failover-' + Date.now())
  return b.inbox.some((m) => m.type === 'chat' && String(m.payload).startsWith('post-failover'))
}, 60000, 2000)
ok(true, 'existing connections resumed chat after failover')

const c = signalClient('carol', 'Carol')
await c.join()
ok(true, 'new join (backplane write to the promoted master) succeeded')

c1.text.insert(0, 'post ')
await until('CRDT resumes after failover', () => c2.text.toString().includes('post '), 30000, 500)
ok(true, 'CRDT sync across instances resumed after failover')

a.ws.close(); b.ws.close(); c.ws.close()
c1.provider.destroy(); c2.provider.destroy()
console.log(`\nALL ${passed} FAILOVER CHECKS PASSED (room=${ROOM})`)
process.exit(0)
