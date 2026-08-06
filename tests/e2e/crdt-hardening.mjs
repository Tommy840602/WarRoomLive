// Durability and limits of the CRDT plane. DESTRUCTIVE: SIGKILLs and restarts
// the collab service to prove an edit survives a crash it never snapshotted.
//   1. an edit made inside the snapshot debounce survives SIGKILL (update log)
//   2. an oversized update is refused without harming other participants
//   3. after the debounce the log is compacted into the snapshot
import { RUN_ID, collabClient, compose, done, ok, psql, sh, sleep, until } from './lib.mjs'

const DOC = 'warroom:hard-' + RUN_ID
const COMPOSE = compose()

// --- 1. Crash durability.
{
  const a = await collabClient(DOC)
  await until('A synced', () => a.provider.isSynced)
  a.text.insert(0, 'survives-crash')
  await sleep(800) // the update-log INSERT lands; the debounced snapshot has not

  ok(Number(psql(`select count(*) from collab_update where name='${DOC}'`)) >= 1,
    'the edit is in the update log before the crash')
  ok(psql(`select count(*) from collab_document where name='${DOC}'`) === '0',
    'no snapshot exists yet (still inside the debounce window)')

  sh(`${COMPOSE} kill collab`) // SIGKILL: no graceful store on the way out
  a.destroy()
  sh(`${COMPOSE} up -d collab`)
  await sleep(3000)

  const b = await collabClient(DOC)
  await until('B synced after the crash', () => b.provider.isSynced, 20000)
  ok(b.text.toString() === 'survives-crash', 'the edit survived SIGKILL via update-log replay')
  b.destroy()
}

// --- 2. Oversized update refused, room unharmed.
{
  const a = await collabClient(DOC)
  const b = await collabClient(DOC)
  await until('both synced', () => a.provider.isSynced && b.provider.isSynced, 20000)

  b.text.insert(b.text.length, ' small-edit-ok')
  await until('small edit synced', () => a.text.toString().includes('small-edit-ok'))

  let closed = false
  a.provider.on('close', () => { closed = true })
  a.text.insert(0, 'X'.repeat(600 * 1024)) // one update over the 512 KB cap
  await until('oversized sender disconnected', () => closed)
  ok(true, 'the connection carrying an oversized update was closed by the server')
  a.provider.disconnect() // stop the client's reconnect-and-resend loop

  b.text.insert(b.text.length, ' b-still-alive')
  const c = await collabClient(DOC)
  await until('C sees clean state', () =>
    c.provider.isSynced && c.text.toString().includes('b-still-alive'), 20000)
  ok(!c.text.toString().includes('XXXX'), 'the oversized content never entered the shared document')
  ok(true, 'other participants kept editing normally')
  ;[a, b, c].forEach((client) => client.destroy())
}

// --- 3. Compaction.
{
  await sleep(6000) // past the store debounce, with margin
  const logged = Number(psql(`select count(*) from collab_update where name='${DOC}'`))
  ok(Number(psql(`select count(*) from collab_document where name='${DOC}'`)) === 1,
    'a snapshot row exists after the debounce')
  ok(logged === 0, `the update log was compacted into it (rows=${logged})`)

  const d = await collabClient(DOC)
  await until('D loads the compacted document', () =>
    d.provider.isSynced && d.text.toString().includes('survives-crash'), 20000)
  ok(true, 'the document loads correctly from the compacted snapshot')
  d.destroy()
}

done('CRDT-HARDENING')
