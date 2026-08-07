// Retention: data past its period is deleted, everything else is left alone.
//
//   docker compose up -d
//   tests/e2e/run.sh retention
//
// Retention is off by default (every period is zero, meaning keep forever), so
// this suite does not wait for the running backend's schedule. It seeds rows on
// both sides of the cutoff, then starts a SECOND backend against the same
// database with short periods and a two-second first pass — `docker compose run`
// inherits the service's environment, so it is the same image and configuration
// with the retention knobs turned on. The running stack is never disturbed.
//
// The interesting assertions are the negative ones. A sweep that deletes
// everything looks identical to a correct one if you only check that old rows
// vanished.
import { RUN_ID, compose, containersOf, done, ok, sh, until } from './lib.mjs'

const COMPOSE = compose()
const ROOM = 'ret-' + RUN_ID
const DAY_MS = 24 * 60 * 60 * 1000
const psql = (sql) =>
  sh(`${COMPOSE} exec -T db psql -U warroomlive -d warroomlive -tAc "${sql}"`)

const old = Date.now() - 30 * DAY_MS
const recent = Date.now() - 60 * 1000

// --- Chat, on both sides of a 7-day cutoff.
psql(`INSERT INTO chat_message (from_id, name, room, text, ts) VALUES `
  + `('u', 'U', '${ROOM}', 'ancient', ${old}), ('u', 'U', '${ROOM}', 'fresh', ${recent})`)

// --- The chat search projection shares chat's period: deleting the message but
// keeping the index would leave search returning text that exists nowhere else.
psql(`INSERT INTO message_search (event_id, room, from_id, name, text, ts, tsv) VALUES `
  + `(gen_random_uuid(), '${ROOM}', 'u', 'U', 'ancient', ${old}, to_tsvector('simple', 'ancient')), `
  + `(gen_random_uuid(), '${ROOM}', 'u', 'U', 'fresh', ${recent}, to_tsvector('simple', 'fresh'))`)

// --- Audit trail.
psql(`INSERT INTO audit_log (event_id, event_type, aggregate_type, aggregate_id, schema_version, payload, occurred_at) VALUES `
  + `(gen_random_uuid(), 'chat.message.created', 'room', '${ROOM}', 1, '{}'::jsonb, now() - interval '30 days'), `
  + `(gen_random_uuid(), 'chat.message.created', 'room', '${ROOM}', 1, '{}'::jsonb, now())`)

// --- Outbox: only PUBLISHED rows are eligible. An old unpublished row is not
// stale history, it is the queue — deleting it would silently lose an event.
psql(`INSERT INTO outbox_events (event_id, event_type, aggregate_type, aggregate_id, payload, occurred_at, published_at) VALUES `
  + `(gen_random_uuid(), 'chat.message.created', 'room', '${ROOM}', '{}'::jsonb, now() - interval '30 days', now() - interval '30 days'), `
  + `(gen_random_uuid(), 'chat.message.created', 'room', '${ROOM}', '{}'::jsonb, now() - interval '30 days', NULL), `
  + `(gen_random_uuid(), 'chat.message.created', 'room', '${ROOM}', '{}'::jsonb, now(), now())`)

// --- Recordings, when the object store is part of this stack. The sweeper has
// to be started from the same overlays, or it inherits a backend with no
// object-store credentials and correctly declines to delete anything.
const RECORDING_COMPOSE = compose('sfu', 'recording')
const hasObjects = containersOf('minio', RECORDING_COMPOSE).length > 0
const SWEEPER_COMPOSE = hasObjects ? RECORDING_COMPOSE : COMPOSE
const OBJECT_KEY = `${ROOM}-old.mp4`
if (hasObjects) {
  sh(`${RECORDING_COMPOSE} exec -T minio sh -c "printf 'x' > /tmp/${OBJECT_KEY}; `
    + `mc alias set local http://localhost:9000 warroom warroomsecret >/dev/null 2>&1 || true; `
    + `mc cp /tmp/${OBJECT_KEY} local/recordings/${OBJECT_KEY}"`)
  psql(`INSERT INTO recordings (room, egress_id, object_key, size_bytes, duration_ms, ended_at) `
    + `VALUES ('${ROOM}', 'EG_RET_${RUN_ID}', '${OBJECT_KEY}', 1, 1000, now() - interval '30 days')`)
}

const count = (sql) => Number(psql(sql))
const chatRows = () => count(`SELECT count(*) FROM chat_message WHERE room = '${ROOM}'`)
const searchRows = () => count(`SELECT count(*) FROM message_search WHERE room = '${ROOM}'`)
const auditRows = () => count(`SELECT count(*) FROM audit_log WHERE aggregate_id = '${ROOM}'`)
const outboxRows = (where) =>
  count(`SELECT count(*) FROM outbox_events WHERE aggregate_id = '${ROOM}'${where}`)
const recordingRows = () => count(`SELECT count(*) FROM recordings WHERE room = '${ROOM}'`)

ok(chatRows() === 2 && searchRows() === 2 && auditRows() === 2 && outboxRows('') === 3,
  'seeded rows on both sides of the cutoff')

// --- Run a sweeper: same image, retention on, first pass two seconds in.
const sweeper = sh(`${SWEEPER_COMPOSE} run -d --rm --no-deps `
  + `-e RETENTION_CHAT_DAYS=7 -e RETENTION_AUDIT_DAYS=7 `
  + `-e RETENTION_PUBLISHED_EVENTS_DAYS=7 -e RETENTION_RECORDINGS_DAYS=7 `
  + `-e RETENTION_INITIAL_DELAY_MS=2000 -e RETENTION_INTERVAL_MS=5000 `
  + `backend`)

try {
  await until('the sweep removes the old chat message', () => chatRows() === 1, 90_000, 1000)
  ok(true, 'the old chat message is gone')
  ok(psql(`SELECT text FROM chat_message WHERE room = '${ROOM}'`) === 'fresh',
    'the row it kept is the recent one, not an arbitrary survivor')

  await until('the search projection is swept with it', () => searchRows() === 1, 30_000, 1000)
  ok(true, 'the search projection is swept with it')
  ok(psql(`SELECT text FROM message_search WHERE room = '${ROOM}'`) === 'fresh',
    'search cannot return a message the database no longer has')

  await until('the old audit entry is removed', () => auditRows() === 1, 30_000, 1000)
  ok(true, 'the old audit entry is removed, the recent one is not')

  await until('the old published outbox row is removed',
    () => outboxRows(" AND published_at IS NOT NULL") === 1, 30_000, 1000)
  ok(true, 'the old published outbox row is removed, the recent one is not')
  ok(outboxRows(' AND published_at IS NULL') === 1,
    'an old UNPUBLISHED outbox row survives — it is the queue, not history')

  if (hasObjects) {
    await until('the expired recording row is removed', () => recordingRows() === 0, 60_000, 1000)
    ok(true, 'the expired recording row is removed')
    const objects = sh(`${RECORDING_COMPOSE} exec -T minio sh -c `
      + `"mc ls local/recordings/${OBJECT_KEY} 2>&1 || true"`)
    ok(!objects.includes(OBJECT_KEY),
      'and its object is gone from the bucket, not just its row')
  } else {
    console.log('   (no object store in this stack — recording retention not exercised)')
  }
} finally {
  sh(`docker rm -f ${sweeper} >/dev/null 2>&1 || true`)
  psql(`DELETE FROM chat_message WHERE room = '${ROOM}'`)
  psql(`DELETE FROM message_search WHERE room = '${ROOM}'`)
  psql(`DELETE FROM audit_log WHERE aggregate_id = '${ROOM}'`)
  psql(`DELETE FROM outbox_events WHERE aggregate_id = '${ROOM}'`)
  psql(`DELETE FROM recordings WHERE room = '${ROOM}'`)
}

done('RETENTION')
