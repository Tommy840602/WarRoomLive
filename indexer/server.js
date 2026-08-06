// WarRoomLive indexer: the example consumer of the warroom.events backbone.
//
// Builds two rebuildable read models in Postgres (blueprint: PostgreSQL is the
// source of truth, projections are derived and disposable):
//   - audit_log       — every event, the durable audit trail;
//   - message_search  — full-text index over chat messages, served by the
//                       backend's GET /api/search/messages.
//
// The pipeline is at-least-once, so consumption is idempotent: event_id is the
// primary key and redeliveries land on ON CONFLICT DO NOTHING. Offsets are
// committed only after the rows are written, so a crash re-consumes (and
// dedupes) rather than losing events.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import kafkajs from 'kafkajs'
import SnappyCodec from 'kafkajs-snappy'
import pg from 'pg'
import * as prom from 'prom-client'

const { CompressionCodecs, CompressionTypes, Kafka, logLevel } = kafkajs

// Envelope contract (bundled copy of docs/contracts/warroom-event.schema.json;
// CI asserts the two stay identical). Schema-invalid envelopes are poison.
const ajv = new Ajv({ allErrors: false })
addFormats(ajv)
const validateEnvelope = ajv.compile(
  JSON.parse(readFileSync(new URL('./warroom-event.schema.json', import.meta.url), 'utf8')),
)

// Producers we don't control (rpk, other services) may compress with snappy,
// which kafkajs does not decode out of the box.
CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const topic = process.env.EVENTS_TOPIC ?? 'warroom.events'
const groupId = process.env.CONSUMER_GROUP ?? 'warroom-indexer'
const metricsPort = Number(process.env.METRICS_PORT ?? 9400)

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'warroomlive',
  user: process.env.DB_USER ?? 'warroomlive',
  password: process.env.DB_PASSWORD ?? 'warroomlive',
})

// Fallback DDL for running without the backend; Flyway V4 owns the canonical
// definitions — keep them in sync.
await pool.query(`
  CREATE TABLE IF NOT EXISTS audit_log (
    event_id       uuid PRIMARY KEY,
    event_type     varchar(100) NOT NULL,
    aggregate_type varchar(50)  NOT NULL,
    aggregate_id   varchar(255) NOT NULL,
    schema_version int          NOT NULL,
    payload        jsonb        NOT NULL,
    occurred_at    timestamptz  NOT NULL,
    indexed_at     timestamptz  NOT NULL DEFAULT now()
  )
`)
await pool.query(`
  CREATE TABLE IF NOT EXISTS message_search (
    event_id uuid PRIMARY KEY,
    room     varchar(255)  NOT NULL,
    from_id  varchar(255)  NOT NULL,
    name     varchar(255)  NOT NULL,
    text     varchar(4000) NOT NULL,
    ts       bigint        NOT NULL,
    tsv      tsvector      NOT NULL
  )
`)

prom.collectDefaultMetrics()
const mConsumed = new prom.Counter({
  name: 'indexer_events_consumed_total',
  help: 'Events consumed from the topic',
  labelNames: ['type'],
})
const mDeduped = new prom.Counter({
  name: 'indexer_events_deduped_total',
  help: 'Redeliveries skipped because the event_id was already indexed',
})
const mFailed = new prom.Counter({
  name: 'indexer_events_failed_total',
  help: 'Events that could not be parsed or written',
})

async function index(envelope) {
  // Both projections commit in one transaction: a failure rolls everything back
  // and the uncommitted offset causes a full redelivery, so the event_id dedup
  // check never sees a half-indexed event.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `INSERT INTO audit_log (event_id, event_type, aggregate_type, aggregate_id, schema_version, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        envelope.eventId,
        envelope.eventType,
        envelope.aggregateType,
        envelope.aggregateId,
        envelope.schemaVersion,
        JSON.stringify(envelope.payload ?? {}),
        envelope.occurredAt,
      ],
    )
    if (rowCount === 0) {
      await client.query('COMMIT')
      mDeduped.inc()
      return
    }
    if (envelope.eventType === 'chat.message.created') {
      const p = envelope.payload
      // 'simple' keeps tokens language-neutral; the backend search also does an
      // ILIKE fallback so CJK text without spaces still matches.
      await client.query(
        `INSERT INTO message_search (event_id, room, from_id, name, text, ts, tsv)
         VALUES ($1, $2, $3, $4, $5, $6, to_tsvector('simple', $7))`,
        [envelope.eventId, envelope.aggregateId, p.fromId, p.name, p.text, p.ts, p.text],
      )
    }
    await client.query('COMMIT')
    mConsumed.inc({ type: envelope.eventType })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const kafka = new Kafka({ clientId: 'warroom-indexer', brokers, logLevel: logLevel.WARN })
const consumer = kafka.consumer({ groupId })
await consumer.connect()
await consumer.subscribe({ topic, fromBeginning: true })
await consumer.run({
  eachMessage: async ({ message }) => {
    let envelope
    try {
      envelope = JSON.parse(message.value.toString())
      if (!validateEnvelope(envelope)) {
        throw new Error('contract violation: ' + ajv.errorsText(validateEnvelope.errors))
      }
    } catch (err) {
      // Poison messages must not wedge the partition: count, log, move on.
      mFailed.inc()
      console.warn('indexer: dropping unparseable event:', err.message)
      return
    }
    // DB errors propagate: kafkajs retries without committing the offset, so
    // transient failures re-deliver instead of silently losing projections.
    await index(envelope)
  },
})
console.log(`indexer consuming ${topic} (group ${groupId}) from ${brokers.join(',')}`)

createServer(async (req, res) => {
  if (req.url?.split('?')[0] === '/metrics') {
    res.writeHead(200, { 'content-type': prom.register.contentType })
    res.end(await prom.register.metrics())
  } else {
    res.writeHead(404)
    res.end()
  }
}).listen(metricsPort, () => console.log(`indexer metrics on :${metricsPort}`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await consumer.disconnect()
    await pool.end()
    process.exit(0)
  })
}
