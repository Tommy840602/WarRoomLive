// WarRoomLive collaboration service: a Hocuspocus (Yjs) WebSocket server.
//
// Browsers connect through the frontend proxy at /ws/doc and sync CRDT updates
// for the room's shared notes. Ephemeral awareness state (cursors, names) is
// relayed but never stored.
//
// Durability is two-tier (blueprint: 增量 update → 合併 snapshot → 清理舊 update):
//   - every incoming Yjs update is appended to collab_update immediately, so
//     edits survive a crash between snapshots;
//   - Hocuspocus's debounced store writes a merged snapshot to collab_document
//     and trims the update rows the snapshot covers (compaction).
// On load, the snapshot is replayed together with any update rows newer than it.
//
// Abuse limits (all env-overridable): single-message size, total document size,
// and per-connection message rate. Exceeding a limit closes that connection;
// other participants are unaffected.
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import * as Y from 'yjs'
import pg from 'pg'

const port = Number(process.env.PORT ?? 1234)
const MAX_UPDATE_BYTES = Number(process.env.COLLAB_MAX_UPDATE_BYTES ?? 512 * 1024)
const MAX_DOC_BYTES = Number(process.env.COLLAB_MAX_DOC_BYTES ?? 5 * 1024 * 1024)
const MAX_MESSAGES_PER_SECOND = Number(process.env.COLLAB_MAX_MESSAGES_PER_SECOND ?? 120)

// Like the backend's chat storage, persistence is best-effort at startup: with a
// reachable Postgres, documents survive restarts; without one (plain local dev),
// the service still runs, holding documents in memory only.
let pool = null
try {
  const candidate = new pg.Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'warroomlive',
    user: process.env.DB_USER ?? 'warroomlive',
    password: process.env.DB_PASSWORD ?? 'warroomlive',
  })
  await candidate.query(`
    CREATE TABLE IF NOT EXISTS collab_document (
      name       text PRIMARY KEY,
      data       bytea NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await candidate.query(`
    CREATE TABLE IF NOT EXISTS collab_update (
      id         bigserial PRIMARY KEY,
      name       text NOT NULL,
      data       bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await candidate.query(
    'CREATE INDEX IF NOT EXISTS collab_update_name_id ON collab_update (name, id)',
  )
  pool = candidate
  console.log('collab service: persisting documents to PostgreSQL')
} catch (err) {
  console.warn(`collab service: PostgreSQL unavailable (${err.message}); documents are in-memory only`)
}

/** Approximate live size per document; corrected to the real snapshot size on store. */
const docSizes = new Map()
/** Highest collab_update id known to be covered by the in-memory doc, per document. */
const lastLoggedId = new Map()
/** Per-connection token bucket for message-rate limiting. */
const buckets = new Map()

function checkRate(socketId) {
  const now = Date.now()
  let b = buckets.get(socketId)
  if (!b) {
    b = { tokens: MAX_MESSAGES_PER_SECOND * 2, last: now }
    buckets.set(socketId, b)
  }
  b.tokens = Math.min(
    MAX_MESSAGES_PER_SECOND * 2,
    b.tokens + ((now - b.last) / 1000) * MAX_MESSAGES_PER_SECOND,
  )
  b.last = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

/** Guards: message size, document size and message rate. Throwing closes the connection. */
const guards = {
  async beforeHandleMessage({ documentName, update, socketId }) {
    if (!checkRate(socketId)) {
      throw new Error(`rate limit exceeded on ${documentName} (${MAX_MESSAGES_PER_SECOND}/s)`)
    }
    if (update.byteLength > MAX_UPDATE_BYTES) {
      throw new Error(
        `update of ${update.byteLength} bytes on ${documentName} exceeds limit ${MAX_UPDATE_BYTES}`,
      )
    }
    const size = docSizes.get(documentName) ?? 0
    if (size + update.byteLength > MAX_DOC_BYTES) {
      throw new Error(`document ${documentName} would exceed size limit ${MAX_DOC_BYTES}`)
    }
  },
  async onDisconnect({ socketId }) {
    buckets.delete(socketId)
  },
}

/** Appends every applied update to the durable log (crash safety between snapshots). */
const updateLog = {
  async onChange({ documentName, update }) {
    if (!pool || !update?.byteLength) return
    docSizes.set(documentName, (docSizes.get(documentName) ?? 0) + update.byteLength)
    const { rows } = await pool.query(
      'INSERT INTO collab_update (name, data) VALUES ($1, $2) RETURNING id',
      [documentName, update],
    )
    lastLoggedId.set(documentName, rows[0].id)
  },
}

const extensions = [guards]
if (pool) {
  extensions.push(
    updateLog,
    new Database({
      fetch: async ({ documentName }) => {
        const snapshot = (
          await pool.query('SELECT data FROM collab_document WHERE name = $1', [documentName])
        ).rows[0]?.data
        const { rows } = await pool.query(
          'SELECT id, data FROM collab_update WHERE name = $1 ORDER BY id',
          [documentName],
        )
        if (rows.length > 0) lastLoggedId.set(documentName, rows[rows.length - 1].id)
        const parts = [...(snapshot ? [snapshot] : []), ...rows.map((r) => r.data)]
        if (parts.length === 0) return null
        const merged = parts.length === 1 ? parts[0] : Y.mergeUpdates(parts)
        docSizes.set(documentName, merged.byteLength)
        return merged
      },
      store: async ({ documentName, state }) => {
        // Read before any await: inserts completing after this point stay in the
        // log and are replayed on the next load (Yjs merges are idempotent).
        const coveredId = lastLoggedId.get(documentName) ?? 0
        await pool.query(
          `INSERT INTO collab_document (name, data, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [documentName, state],
        )
        await pool.query('DELETE FROM collab_update WHERE name = $1 AND id <= $2', [
          documentName,
          coveredId,
        ])
        docSizes.set(documentName, state.byteLength)
      },
    }),
  )
}

const server = Server.configure({ port, extensions })

server.listen().then(() => {
  console.log(`collab service listening on :${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.destroy()
    await pool?.end()
    process.exit(0)
  })
}
