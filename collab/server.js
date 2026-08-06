// WarRoomLive collaboration service: a Hocuspocus (Yjs) WebSocket server.
//
// Browsers connect through the frontend proxy at /ws/doc and sync CRDT updates
// for the room's shared notes. Documents are persisted as Yjs binary snapshots
// in the same Postgres instance the backend uses (table: collab_document).
// Ephemeral awareness state (cursors, names) is relayed but never stored.
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import pg from 'pg'

const port = Number(process.env.PORT ?? 1234)

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
  pool = candidate
  console.log('collab service: persisting documents to PostgreSQL')
} catch (err) {
  console.warn(`collab service: PostgreSQL unavailable (${err.message}); documents are in-memory only`)
}

const server = Server.configure({
  port,
  extensions: pool
    ? [
        new Database({
          fetch: async ({ documentName }) => {
            const { rows } = await pool.query(
              'SELECT data FROM collab_document WHERE name = $1',
              [documentName],
            )
            return rows[0]?.data ?? null
          },
          store: async ({ documentName, state }) => {
            await pool.query(
              `INSERT INTO collab_document (name, data, updated_at)
               VALUES ($1, $2, now())
               ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
              [documentName, state],
            )
          },
        }),
      ]
    : [],
})

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
