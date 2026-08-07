// The event backbone end to end, for the events overlay:
//   docker compose -f docker-compose.yml -f docker-compose.events.yml up -d
//   tests/e2e/run.sh events
//
// Drives real user activity, then follows it through outbox → Redpanda →
// indexer → read models → search API, and finally re-produces one envelope
// verbatim to prove consumption is idempotent (the at-least-once contract).
import { ORIGIN, RUN_ID, collabClient, compose, done, ok, psql, sh, signalClient, sleep, until } from './lib.mjs'

const ROOM = 'events-' + RUN_ID
const COMPOSE = compose('events')
const query = (sql) => psql(sql, COMPOSE)

// --- Activity: join, chat twice, edit the shared document, leave.
{
  const alice = signalClient('alice', 'Alice')
  await alice.join(ROOM)
  alice.send({ type: 'chat', room: ROOM, from: 'alice', payload: '週五要 deploy 新版本' })
  alice.send({ type: 'chat', room: ROOM, from: 'alice', payload: 'searchable unique-marker-' + RUN_ID })

  const notes = await collabClient('warroom:' + ROOM)
  await until('notes synced', () => notes.provider.isSynced, 15000)
  notes.text.insert(0, 'meeting notes')
  await sleep(4000) // let the debounced snapshot — and its event — land
  notes.destroy()
  alice.close()
  await sleep(1500)
}

// --- Read models fill asynchronously.
await until('audit trail complete', () => {
  const types = query(
    `select event_type from audit_log where aggregate_id in ('${ROOM}', 'warroom:${ROOM}')`)
  const lines = types.split('\n')
  return lines.includes('participant.joined')
    && lines.filter((t) => t === 'chat.message.created').length === 2
    && lines.includes('participant.left')
    && lines.includes('document.snapshot.created')
}, 30000, 500)
ok(true, 'audit_log holds the join, both chats, the leave and the snapshot event')

// --- Search read model, built by the same consumer.
const hits = await (await fetch(
  `${ORIGIN}/api/search/messages?q=unique-marker-${RUN_ID}`)).json()
ok(hits.length === 1 && hits[0].room === ROOM && hits[0].name === 'Alice',
  'the search API finds the chat through the async pipeline')

const scoped = await (await fetch(
  `${ORIGIN}/api/search/messages?q=deploy&room=${ROOM}`)).json()
ok(scoped.length === 1 && scoped[0].text.includes('週五'),
  'room-scoped search matches a message with CJK text')

// --- Idempotence: replay an envelope the indexer has already consumed.
{
  const before = Number(query(`select count(*) from audit_log where aggregate_id='${ROOM}'`))
  const envelope = query(
    `select json_build_object('eventId', event_id, 'eventType', event_type, `
    + `'aggregateType', aggregate_type, 'aggregateId', aggregate_id, `
    + `'schemaVersion', schema_version, 'occurredAt', occurred_at, 'payload', payload)::text `
    + `from outbox_events where aggregate_id='${ROOM}' `
    + `and event_type='chat.message.created' limit 1`)
  sh(`${COMPOSE} exec -T redpanda rpk topic produce warroom.events`, { input: envelope + '\n' })
  await sleep(4000)

  const after = Number(query(`select count(*) from audit_log where aggregate_id='${ROOM}'`))
  ok(after === before, `the replayed duplicate created no new audit rows (${before} → ${after})`)

  const metrics = sh(`${COMPOSE} exec -T indexer wget -qO- http://localhost:9400/metrics`)
  const deduped = Number(metrics.match(/indexer_events_deduped_total (\d+)/)?.[1])
  ok(deduped >= 1, `the indexer counted the duplicate as deduped (${deduped})`)
}

done('EVENTS')
