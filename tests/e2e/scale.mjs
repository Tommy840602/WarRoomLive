// Multi-node behaviour, for the scale overlay. DESTRUCTIVE: SIGKILLs one
// backend replica to prove the survivors clean up after it.
//   docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d
//   tests/e2e/run.sh scale
//
// Covers CRDT convergence across collab replicas, and ghost pruning: a node
// that dies cannot disconnect its peers, so the survivors must drop them once
// its heartbeat expires.
import {
  RUN_ID, collabClient, compose, containersOf, done, logMatches, ok, sh, signalClient, sleep, until,
} from './lib.mjs'

const COMPOSE = compose('scale')

// --- 1. CRDT convergence across collab replicas.
{
  const DOC = 'warroom:scale-' + RUN_ID
  // Several clients so nginx's request-time DNS spreads them over both replicas.
  const clients = await Promise.all([1, 2, 3, 4].map(() => collabClient(DOC)))
  await until('all synced', () => clients.every((c) => c.provider.isSynced), 20000)

  clients[0].text.insert(0, 'scale-sync ')
  await until('replicated to all', () =>
    clients.every((c) => c.text.toString().includes('scale-sync')), 20000)
  clients[3].text.insert(clients[3].text.length, 'from-last')
  await until('replicated back', () =>
    clients.every((c) => c.text.toString().includes('from-last')), 20000)

  ok(true, 'CRDT edits converge across clients spread over the collab replicas')
  clients.forEach((c) => c.destroy())
}

// --- 2. Ghost pruning after a node dies without closing its sockets.
{
  const ROOM = 'ghost-' + RUN_ID
  const backends = containersOf('backend', COMPOSE)
  ok(backends.length >= 2, `the scale overlay is up (${backends.length} backend replicas)`)
  const [survivor, doomed] = backends

  const members = []
  for (let i = 0; i < 4; i++) {
    const peer = signalClient('peer' + i, 'P' + i)
    await peer.join(ROOM)
    members.push(peer)
  }
  const placement = backends.map((c) => logMatches(c, `joined room ${ROOM}`))
  ok(placement.every((n) => n >= 1), `the room spans both nodes (${placement.join('/')})`)

  sh(`docker kill ${doomed}`) // abrupt: no chance to close its sockets cleanly
  console.log('   (killed ' + doomed + ', waiting out the 15s heartbeat TTL…)')
  await sleep(18000)

  // A fresh join reads the directory, which prunes members whose node is gone.
  const checker = signalClient('checker', 'Checker')
  const fresh = await checker.join(ROOM)
  const ids = fresh.payload.map((p) => p.id)
  const hostedByDead = logMatches(doomed, `joined room ${ROOM}`)

  ok(logMatches(survivor, 'Pruning ghost peer') >= 1,
    "the dead node's peers were pruned as ghosts")
  ok(ids.length === 4 - hostedByDead,
    `membership lists only the survivors (${ids.length} of 4, ${hostedByDead} were on the dead node)`)

  members.forEach((m) => m.close())
  checker.close()
}

// The killed replica stays down; `docker compose … up -d` brings it back.
done('SCALE')
