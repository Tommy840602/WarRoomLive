// Multi-node behaviour, for the scale overlay. DESTRUCTIVE: SIGKILLs one
// backend replica to prove the survivors clean up after it.
//   docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d
//   tests/e2e/run.sh scale
//
// Covers CRDT convergence across collab replicas, and ghost pruning: a node
// that dies cannot disconnect its peers, so the survivors must drop them once
// its heartbeat expires.
import {
  RUN_ID, addressesOf, collabClient, compose, containersOf, done, isRunning, logMatches, ok, sh,
  signalClient, sleep, until,
} from './lib.mjs'

const COMPOSE = compose('scale')

// --- 1. CRDT convergence across collab replicas.
//
// Clients are PINNED to a replica each rather than sent through the proxy:
// round-robin can put every client on the same instance, and a suite that
// happens to do so passes while cross-instance sync is completely broken.
{
  const DOC = 'warroom:scale-' + RUN_ID
  const replicas = addressesOf('collab', COMPOSE)
  ok(replicas.length >= 2, `the scale overlay is up (${replicas.length} collab replicas)`)

  const [a, b] = await Promise.all(
    replicas.slice(0, 2).map((r) => collabClient(DOC, { url: `ws://${r.ip}:1234` })))
  await until('both replicas synced', () => a.provider.isSynced && b.provider.isSynced, 20000)

  a.text.insert(0, 'from-replica-1 ')
  await until('edit crossed 1 → 2', () => b.text.toString().includes('from-replica-1'), 20000)
  b.text.insert(b.text.length, 'from-replica-2')
  await until('edit crossed 2 → 1', () => a.text.toString().includes('from-replica-2'), 20000)
  ok(true, 'document edits cross between clients pinned to different replicas')

  // Awareness travels the same Redis channel as updates but through a separate
  // code path; a replica that cannot decode a peer's awareness frame dies on it.
  a.provider.setAwarenessField('user', { name: 'Alice', color: '#f00' })
  b.provider.setAwarenessField('user', { name: 'Bob', color: '#00f' })
  await until('awareness crossed replicas', () =>
    [...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Alice')
    && [...a.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Bob'), 20000)
  ok(true, 'awareness (cursor presence) crosses replicas')

  a.destroy()
  b.destroy()
  await sleep(1000)
  ok(replicas.every((r) => isRunning(r.name)),
    'every collab replica is still running after cross-replica traffic')
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
