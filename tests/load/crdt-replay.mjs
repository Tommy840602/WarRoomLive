// CRDT replay benchmark: how long does rebuilding a room's document from
// Postgres take as its history grows? This is the cost paid on every cold doc
// load (and by the DR drill's verification), so it bounds how long compaction
// can be deferred.
//
// For each configured edit count it drives the real collab service over
// /ws/doc (so updates take the production path: update-log append + debounced
// snapshot), then measures a cold rebuild — read snapshot + log rows, merge,
// apply — exactly as the service does when nobody holds the document.
//
// Usage: node tests/load/crdt-replay.mjs [edits...]   (default 200 1000 5000)
import { createHash } from 'node:crypto'
import pg from 'pg'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const SIZES = process.argv.slice(2).map(Number).filter(Boolean)
const EDIT_COUNTS = SIZES.length ? SIZES : [200, 1000, 5000]
const DOC_URL = process.env.DOC_URL ?? 'ws://localhost:8088/ws/doc'

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: 'warroomlive',
  user: 'warroomlive',
  password: 'warroomlive',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Writes `edits` single-character insertions through the collab service. */
async function seed(room, edits) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: DOC_URL, name: `warroom:${room}`, document: doc, WebSocketPolyfill: WebSocket,
  })
  const t0 = Date.now()
  while (!provider.isSynced) {
    if (Date.now() - t0 > 15000) throw new Error('collab sync timeout')
    await sleep(50)
  }
  const text = doc.getText('notes')
  // One Yjs transaction => one update message, so batching keeps us under the
  // collab service's per-connection rate limit (default 120 msg/s) — the same
  // ceiling a real client faces. BATCH mirrors a burst of typing between flushes.
  const BATCH = Number(process.env.REPLAY_BATCH ?? 25)
  for (let sent = 0; sent < edits; sent += BATCH) {
    const n = Math.min(BATCH, edits - sent)
    doc.transact(() => {
      for (let i = 0; i < n; i++) text.insert(text.length, String.fromCharCode(97 + ((sent + i) % 26)))
    })
    await sleep(20) // ~50 msg/s, comfortably inside the limit
  }
  await sleep(Number(process.env.REPLAY_SETTLE_MS ?? 2000))
  provider.destroy()
}

/** Cold rebuild straight from the database: snapshot ⊕ update log. */
async function rebuild(room) {
  const name = `warroom:${room}`
  const readStart = performance.now()
  const { rows: snap } = await pool.query('SELECT data FROM collab_document WHERE name = $1', [name])
  const { rows: logs } = await pool.query(
    'SELECT data FROM collab_update WHERE name = $1 ORDER BY id', [name])
  const readMs = performance.now() - readStart

  const parts = [...snap.map((r) => r.data), ...logs.map((r) => r.data)]
  const mergeStart = performance.now()
  const merged = parts.length === 1 ? parts[0] : Y.mergeUpdates(parts)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, merged)
  const applyMs = performance.now() - mergeStart

  const state = Y.encodeStateAsUpdate(doc)
  return {
    readMs, applyMs,
    logRows: logs.length,
    snapshotBytes: snap[0]?.data?.length ?? 0,
    logBytes: logs.reduce((n, r) => n + r.data.length, 0),
    chars: doc.getText('notes').length,
    hash: createHash('sha256').update(state).digest('hex').slice(0, 12),
  }
}

// Two measurements per size. The document is rebuilt as soon as the edits are
// in (hot: the update log still holds every uncompacted row — the worst case a
// crash-time rebuild faces), then again after the debounced snapshot has landed
// and trimmed the log (compacted: the steady state).
console.log('edits | phase     | log rows | snapshot B | log B | read ms | rebuild ms | chars | hash')
console.log('------+-----------+----------+------------+-------+---------+------------+-------+-------------')
const row = (edits, phase, r) =>
  console.log(
    `${String(edits).padStart(5)} | ${phase.padEnd(9)} | ${String(r.logRows).padStart(8)} | ` +
    `${String(r.snapshotBytes).padStart(10)} | ${String(r.logBytes).padStart(5)} | ` +
    `${r.readMs.toFixed(1).padStart(7)} | ${r.applyMs.toFixed(1).padStart(10)} | ` +
    `${String(r.chars).padStart(5)} | ${r.hash}`)

for (const edits of EDIT_COUNTS) {
  const room = `replay-${edits}-${Date.now()}`
  await seed(room, edits)
  const hot = await rebuild(room)
  row(edits, 'uncompact', hot)
  await sleep(Number(process.env.REPLAY_COMPACT_WAIT_MS ?? 6000))
  const cold = await rebuild(room)
  row(edits, 'compacted', cold)

  for (const [phase, r] of [['uncompacted', hot], ['compacted', cold]]) {
    if (r.chars !== edits) {
      console.error(`FAIL: ${phase} rebuild has ${r.chars} chars, expected ${edits}`)
      process.exit(1)
    }
  }
  if (hot.hash !== cold.hash) {
    console.error(`FAIL: compaction changed the rebuilt state (${hot.hash} != ${cold.hash})`)
    process.exit(1)
  }
}
console.log('\nAll rebuilds reproduced the full edit history; compaction preserved state hashes.')
await pool.end()
process.exit(0)
