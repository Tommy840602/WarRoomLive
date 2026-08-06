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
import { Redis as RedisSync } from '@hocuspocus/extension-redis'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import * as Y from 'yjs'
import pg from 'pg'
import * as prom from 'prom-client'

const port = Number(process.env.PORT ?? 1234)
// Emit document.snapshot.created into the shared outbox (events overlay only —
// without the backend's kafka-profile publisher the rows would just pile up).
const eventsEnabled = process.env.EVENTS_ENABLED === 'true'
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
  if (eventsEnabled) {
    // Fallback for starting before the backend has run Flyway (V3 owns this).
    await candidate.query(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id             bigserial PRIMARY KEY,
        event_id       uuid         NOT NULL UNIQUE,
        event_type     varchar(100) NOT NULL,
        aggregate_type varchar(50)  NOT NULL,
        aggregate_id   varchar(255) NOT NULL,
        schema_version int          NOT NULL DEFAULT 1,
        payload        jsonb        NOT NULL,
        occurred_at    timestamptz  NOT NULL DEFAULT now(),
        published_at   timestamptz
      )
    `)
  }
  pool = candidate
  console.log('collab service: persisting documents to PostgreSQL')
} catch (err) {
  console.warn(`collab service: PostgreSQL unavailable (${err.message}); documents are in-memory only`)
}

// --- Prometheus metrics, served at GET /metrics on the same listener. Like the
// backend's /actuator, nginx does not proxy this path, so it stays internal to
// the compose network (the observability overlay's Prometheus).
prom.collectDefaultMetrics()
const mUpdates = new prom.Counter({
  name: 'collab_updates_total',
  help: 'Yjs updates applied to documents',
})
const mUpdateBytes = new prom.Histogram({
  name: 'collab_update_bytes',
  help: 'Size of applied Yjs updates in bytes',
  buckets: [64, 256, 1024, 4096, 16384, 65536, 262144, 1048576],
})
const mRejected = new prom.Counter({
  name: 'collab_rejections_total',
  help: 'Connections closed for violating a limit or failing authentication',
  labelNames: ['reason'],
})
const mFetch = new prom.Histogram({
  name: 'collab_fetch_seconds',
  help: 'Time to load a document from Postgres (snapshot + log replay)',
  buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 1, 5],
})
const mStore = new prom.Histogram({
  name: 'collab_store_seconds',
  help: 'Time to store a snapshot and trim the update log',
  buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 1, 5],
})

/** Serves /metrics; any other request falls through to Hocuspocus's default. */
const metricsEndpoint = {
  async onRequest({ request, response }) {
    if (request.url?.split('?')[0] === '/metrics') {
      const body = await prom.register.metrics()
      response.writeHead(200, { 'content-type': prom.register.contentType })
      response.end(body)
      throw null // short-circuit the remaining hooks and default handler
    }
  },
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
      mRejected.inc({ reason: 'rate' })
      throw new Error(`rate limit exceeded on ${documentName} (${MAX_MESSAGES_PER_SECOND}/s)`)
    }
    if (update.byteLength > MAX_UPDATE_BYTES) {
      mRejected.inc({ reason: 'update_size' })
      throw new Error(
        `update of ${update.byteLength} bytes on ${documentName} exceeds limit ${MAX_UPDATE_BYTES}`,
      )
    }
    const size = docSizes.get(documentName) ?? 0
    if (size + update.byteLength > MAX_DOC_BYTES) {
      mRejected.inc({ reason: 'doc_size' })
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
    if (!update?.byteLength) return
    mUpdates.inc()
    mUpdateBytes.observe(update.byteLength)
    if (!pool) return
    docSizes.set(documentName, (docSizes.get(documentName) ?? 0) + update.byteLength)
    const { rows } = await pool.query(
      'INSERT INTO collab_update (name, data) VALUES ($1, $2) RETURNING id',
      [documentName, update],
    )
    lastLoggedId.set(documentName, rows[0].id)
  },
}

const extensions = [metricsEndpoint, guards, updateLog]

// Multi-instance mode: with REDIS_HOST set, Hocuspocus instances sync document
// updates and awareness through Redis, so replicas can serve the same documents
// (see docker-compose.scale.yml). Unset in local dev → single instance, no Redis.
if (process.env.REDIS_HOST) {
  extensions.push(
    new RedisSync({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT ?? 6379),
    }),
  )
  console.log(`collab service: syncing across instances via Redis at ${process.env.REDIS_HOST}`)
}
if (pool) {
  extensions.push(
    new Database({
      fetch: async ({ documentName }) => {
        const done = mFetch.startTimer()
        try {
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
        } finally {
          done()
        }
      },
      store: async ({ documentName, state }) => {
        const done = mStore.startTimer()
        const client = await pool.connect()
        try {
          // Read before any await: inserts completing after this point stay in the
          // log and are replayed on the next load (Yjs merges are idempotent).
          const coveredId = lastLoggedId.get(documentName) ?? 0
          await client.query('BEGIN')
          await client.query(
            `INSERT INTO collab_document (name, data, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [documentName, state],
          )
          await client.query('DELETE FROM collab_update WHERE name = $1 AND id <= $2', [
            documentName,
            coveredId,
          ])
          if (eventsEnabled) {
            // Same transactional-outbox table the backend publishes from: the
            // snapshot and its event commit or roll back together.
            await client.query(
              `INSERT INTO outbox_events (event_id, event_type, aggregate_type, aggregate_id, schema_version, payload)
               VALUES (gen_random_uuid(), 'document.snapshot.created', 'document', $1, 1, $2::jsonb)`,
              [documentName, JSON.stringify({ sizeBytes: state.byteLength })],
            )
          }
          await client.query('COMMIT')
          docSizes.set(documentName, state.byteLength)
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          throw err
        } finally {
          client.release()
          done()
        }
      },
    }),
  )
}

// OIDC: when an issuer is configured, every connection must present a JWT from it
// (HocuspocusProvider's `token` option). Unset in local dev → open, matching the
// backend's profile-gated security. The JWKS is fetched from OIDC_JWK_SET_URI
// (internal address behind the single-origin proxy) while `iss` must equal the
// public OIDC_ISSUER string browsers see.
const oidcIssuer = process.env.OIDC_ISSUER
const jwks = oidcIssuer
  ? createRemoteJWKSet(new URL(process.env.OIDC_JWK_SET_URI ?? `${oidcIssuer}/jwks`))
  : null
if (oidcIssuer) console.log(`collab service: requiring JWTs issued by ${oidcIssuer}`)

const server = Server.configure({
  port,
  extensions,
  ...(oidcIssuer
    ? {
        async onAuthenticate({ token }) {
          try {
            if (!token) throw new Error('missing access token')
            const { payload } = await jwtVerify(token, jwks, { issuer: oidcIssuer })
            return { user: payload.preferred_username ?? payload.sub }
          } catch (err) {
            mRejected.inc({ reason: 'auth' })
            throw err
          }
        },
      }
    : {}),
})

new prom.Gauge({
  name: 'collab_connections_active',
  help: 'Open WebSocket connections',
  collect() { this.set(server.getConnectionsCount()) },
})
new prom.Gauge({
  name: 'collab_documents_open',
  help: 'Documents currently loaded in memory',
  collect() { this.set(server.getDocumentsCount()) },
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
