// CRDT rebuild verification (blueprint: 從空資料庫 → 載入 snapshot → replay
// updates → 驗證文件 hash 和內容): reads every collab document from a database,
// rebuilds it by merging snapshot ⊕ update log with Yjs, and prints one line per
// document: <name> <sha256-of-rebuilt-state> <notes-text-preview>.
// Compare the output for the source and restored databases.
// Usage: node verify-crdt.mjs <db-host> [db-port]
import { createHash } from 'node:crypto'
import pg from 'pg'
import * as Y from 'yjs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 5432)

const pool = new pg.Pool({
  host, port, database: 'warroomlive', user: 'warroomlive', password: 'warroomlive',
})

const { rows: docs } = await pool.query('SELECT name, data FROM collab_document ORDER BY name')
for (const row of docs) {
  const { rows: logs } = await pool.query(
    'SELECT data FROM collab_update WHERE name = $1 ORDER BY id', [row.name])
  const parts = [row.data, ...logs.map((l) => l.data)]
  const merged = parts.length === 1 ? parts[0] : Y.mergeUpdates(parts)

  const doc = new Y.Doc()
  Y.applyUpdate(doc, merged)
  const rebuiltState = Y.encodeStateAsUpdate(doc)
  const hash = createHash('sha256').update(rebuiltState).digest('hex').slice(0, 16)
  const text = doc.getText('e2e').toString().slice(0, 40)
  console.log(`${row.name} ${hash} "${text}"`)
}
await pool.end()
