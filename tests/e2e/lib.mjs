// Shared harness for the e2e suites. Every suite drives the stack the way a
// browser does — through the single nginx origin (:8088 by default), never
// against a service port directly — so the proxy routing is part of what is
// being tested. Override with E2E_ORIGIN when the stack is published elsewhere.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ORIGIN = process.env.E2E_ORIGIN ?? 'http://localhost:8088'
export const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws')
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// --- Authentication, once, for every suite ------------------------------
//
// Each overlay used to be exercised on its own, so a suite could assume the
// stack it was written for. That stops being true the moment overlays are
// combined: with the oidc overlay in the mix EVERY socket handshake and every
// /api call needs a bearer, and a suite that does not carry one fails in a way
// that looks like the feature is broken rather than like the suite is
// unauthenticated.
//
// So the harness logs in if — and only if — the running stack says it wants
// authentication, and everything below carries the token by default.
const rawFetch = globalThis.fetch.bind(globalThis)

async function login() {
  try {
    const config = await rawFetch(`${ORIGIN}/api/auth/config`)
    if (!config.ok) return null
    const { enabled } = await config.json()
    if (!enabled) return null
    // The dev IdP's password grant, the same one the oidc suite uses; a real
    // provider would need its own flow, which is why this is best-effort.
    const res = await rawFetch(`${ORIGIN}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=password&username=alice&password=alice123&client_id=warroomlive-web',
    })
    if (!res.ok) return null
    return (await res.json()).access_token ?? null
  } catch {
    return null
  }
}

/** The ambient token: a string under the oidc overlay, null without it. */
export const AUTH_TOKEN = await login()

// Only `/api` requests, and only when the caller has not set its own header.
// `/auth/*` is the IdP itself, and a presigned `/objects/*` URL carries its
// signature in the query — adding a bearer to either would change what is being
// tested. Callers that pass their own Authorization (the oidc suite asserting
// what Bob may not read) are left exactly as they are.
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? ''
  const headers = new Headers(init.headers ?? {})
  if (AUTH_TOKEN && url.startsWith(`${ORIGIN}/api/`) && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${AUTH_TOKEN}`)
    return rawFetch(input, { ...init, headers })
  }
  return rawFetch(input, init)
}

/** Unique per run so suites can be re-run against a stack that keeps its data. */
export const RUN_ID = process.argv[2] ?? String(Date.now())

let passed = 0

export function ok(cond, label) {
  if (!cond) {
    console.error('FAIL: ' + label)
    process.exit(1)
  }
  console.log('ok: ' + label)
  passed++
}

export function done(suite) {
  console.log(`\nALL ${passed} ${suite} CHECKS PASSED`)
  process.exit(0)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls until `pred` holds, or throws with `label` in the message. */
export async function until(label, pred, ms = 10000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${label}`)
    await sleep(step)
  }
}

// --- docker helpers -------------------------------------------------------
// Paths are resolved from the repo root, so suites run from any cwd.

/**
 * `docker compose` for the stack that is actually running.
 *
 * <p>There is one compose file now, so this is about PROFILES rather than
 * `-f` flags: a command issued without the profiles the stack was started with
 * describes a smaller project than the one running, and these commands are not
 * all read-only — `docker compose run` reconciles services to the config it is
 * given. That is how a sweeper once recreated collab without the events
 * feature's environment and silently stopped snapshot events for a whole
 * session, with nothing logged.
 *
 * <p>So when `stack.sh up` has recorded what it started, that wins. The named
 * features are the fallback for a stack brought up by hand.
 */
export function compose(...features) {
  const base = `docker compose -f ${REPO_ROOT}docker-compose.yml`
  const recorded = readStackProfiles()
  if (recorded !== null) return `${base} ${recorded}`.trim()
  return `${base} ${features.map((f) => `--profile ${f}`).join(' ')}`.trim()
}

/**
 * Loads the feature environment `stack.sh up` recorded, once, at import.
 *
 * <p>Without this every `docker compose` a suite shells out to describes a
 * DIFFERENT stack: the profiles come from `.stack.env` but the variables that
 * switch each feature on do not, so `EVENTS_ENABLED` and friends fall back to
 * their "off" defaults. Compose then sees a changed configuration and recreates
 * the service to match — collab came back with events disabled in the middle of
 * a suite run, and `document.snapshot.created` stopped being written with
 * nothing logged anywhere.
 *
 * <p>The overlay model hid this: a file list is self-describing, so replaying it
 * reproduced the same config. A set of environment variables is not, which is
 * the one real edge the old model had and the reason this exists.
 *
 * <p>Existing values win, so a suite can still override a single variable.
 */
function loadStackEnv() {
  try {
    for (const line of readFileSync(`${REPO_ROOT}.stack.env`, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
    }
  } catch {
    // No recorded stack: the suites are running against one brought up by hand.
  }
}
loadStackEnv()

/** The `--profile` flags `stack.sh up` recorded, or null if it never ran. */
function readStackProfiles() {
  try {
    const raw = readFileSync(`${REPO_ROOT}.stack.env`, 'utf8')
    const match = raw.match(/WARROOM_PROFILE_ARGS='([^']*)'/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export const sh = (cmd, opts) => execSync(cmd, opts).toString().trim()

export const psql = (sql, cmd = compose()) =>
  sh(`${cmd} exec -T db psql -U warroomlive -d warroomlive -tAc "${sql}"`)

/**
 * Container names for a compose service, in stable order. Replica numbering is
 * not predictable (a recreated service keeps counting up), so suites that need
 * a specific container must resolve it here rather than hard-coding a suffix.
 */
export function containersOf(service, cmd = compose()) {
  const out = sh(`${cmd} ps --format '{{.Name}}' ${service} || true`)
  return out ? out.split('\n').filter(Boolean).sort() : []
}

/** Count of matching lines in a container's log — used for placement assertions. */
export function logMatches(container, pattern) {
  return Number(sh(`docker logs ${container} 2>&1 | grep -c "${pattern}" || true`))
}

// --- signaling plane ------------------------------------------------------

/**
 * One signaling connection with an awaitable, type-keyed inbox. Messages that
 * arrive before they are awaited are queued, so a suite never races the server.
 */
export function signalClient(id, name = id, opts = {}) {
  // `'token' in opts` rather than a default value: passing an empty token on
  // purpose means "connect anonymously", which is a thing the oidc suite tests.
  const token = 'token' in opts ? opts.token : AUTH_TOKEN
  const url = `${WS_ORIGIN}/ws/signal${token ? `?access_token=${encodeURIComponent(token)}` : ''}`
  const ws = new WebSocket(url)
  const queue = []
  const waiters = []
  let closeEvent = null
  const closeWaiters = []

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const i = waiters.findIndex((w) => w.type === msg.type)
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
    else queue.push(msg)
  }
  ws.onclose = (ev) => {
    closeEvent = ev
    closeWaiters.splice(0).forEach((resolve) => resolve(ev))
  }

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`${id}: signaling socket failed to open`))
  })

  const next = (type, ms = 5000) => {
    const i = queue.findIndex((m) => m.type === type)
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${id}: timeout waiting for '${type}'`)), ms)
      waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m) } })
    })
  }

  const awaitClose = (ms = 5000) =>
    closeEvent
      ? Promise.resolve(closeEvent)
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`${id}: timeout waiting for close`)), ms)
          closeWaiters.push((ev) => { clearTimeout(t); resolve(ev) })
        })

  const send = (msg) => ws.send(JSON.stringify(msg))
  const seen = (type, pred = () => true) => queue.some((m) => m.type === type && pred(m))
  /** How many messages of a type are sitting unread — for counting what arrived. */
  const inboxSize = (type) => queue.filter((m) => m.type === type).length
  /** Awaits a message matching a predicate, skipping ones that do not. */
  const until = async (type, pred, ms = 8000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const i = queue.findIndex((m) => m.type === type && pred(m))
      if (i >= 0) return queue.splice(i, 1)[0]
      if (Date.now() > deadline) throw new Error(`${id}: timeout waiting for a matching '${type}'`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * join + await the `peers` reply, the handshake every suite starts from.
   * `claimedName` overrides what the client asks to be called — the server may
   * well overrule it, which is the point of asking.
   */
  const join = async (room, claimedName = name) => {
    await opened
    send({ type: 'join', room, from: id, payload: claimedName })
    return next('peers')
  }

  return {
    id, name, ws, opened, next, send, join, seen, inboxSize, until, awaitClose,
    close: () => ws.close(),
  }
}

// --- collab (CRDT) plane --------------------------------------------------

/**
 * The room cap in force, found by filling a throwaway room until the server
 * refuses. The cap is configuration — 8 by default, 50 under the SFU overlay —
 * so a suite that hard-codes it passes on one stack and fails on another for
 * no good reason. The server states the cap in the `room-full` payload, and
 * this checks that claim against the number it actually admitted.
 */
export async function discoverRoomCap(probeRoom = 'cap-probe-' + RUN_ID) {
  const clients = []
  try {
    for (let i = 0; i < 200; i++) {
      const peer = signalClient('probe' + i)
      await peer.opened
      clients.push(peer)
      peer.send({ type: 'join', room: probeRoom, from: peer.id, payload: peer.id })
      const reply = await Promise.race([
        peer.next('peers', 8000).then(() => null),
        peer.next('room-full', 8000).then((m) => m),
      ])
      if (reply) {
        const claimed = reply.payload
        const admitted = clients.length - 1
        if (claimed !== admitted) {
          throw new Error(`server claims cap ${claimed} but admitted ${admitted}`)
        }
        return claimed
      }
    }
    throw new Error('room cap not reached within 200 joins')
  } finally {
    clients.forEach((c) => c.close())
  }
}

/**
 * A Yjs client on the shared document plane. Imported lazily so suites that
 * only touch signaling do not need the Yjs dependencies loaded.
 */
export async function collabClient(docName, opts = {}) {
  const { field = 'e2e', url } = opts
  const token = 'token' in opts ? opts.token : AUTH_TOKEN
  const [Y, { HocuspocusProvider }] = await Promise.all([
    import('yjs'),
    import('@hocuspocus/provider'),
  ])
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    // `url` pins the client to one replica, bypassing the proxy's round-robin.
    url: url ?? `${WS_ORIGIN}/ws/doc`,
    name: docName,
    document: doc,
    ...(token ? { token } : {}),
    WebSocketPolyfill: WebSocket,
  })
  return { doc, provider, text: doc.getText(field), destroy: () => provider.destroy() }
}

/** Address of each container backing a service, for replica-pinned clients. */
export function addressesOf(service, cmd = compose()) {
  return containersOf(service, cmd).map((name) => ({
    name,
    ip: sh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${name}`),
  }))
}

/** True while the container is running — a crashed replica is the failure mode. */
export const isRunning = (container) =>
  sh(`docker inspect -f '{{.State.Status}}' ${container} || true`) === 'running'
