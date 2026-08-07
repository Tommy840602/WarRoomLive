// Recording library: a completed recording becomes a listed, playable item.
// Needs the sfu + recording overlays (LiveKit credentials, MinIO, a database).
//
//   docker compose -f docker-compose.yml -f docker-compose.sfu.yml \
//     -f docker-compose.recording.yml up -d
//   tests/e2e/run.sh recordings
//
// The recording itself is simulated by delivering the webhook LiveKit Egress
// would send — signed exactly as LiveKit signs it — with a real object put in
// the bucket. That covers everything this feature owns (webhook → row → list →
// presigned URL → playback through the proxy) without waiting on a headless
// Chrome compositor, and it exercises the signature path, which is the part
// that fails silently if it is wrong.
import { createHash, createHmac } from 'node:crypto'
import { ORIGIN, RUN_ID, compose, done, ok, sh, sleep } from './lib.mjs'

const ROOM = 'rec-' + RUN_ID
const COMPOSE = compose('sfu', 'recording')
// Dev credentials from the recording overlay.
const API_KEY = 'devkey'
const API_SECRET = 'devkey_secret_needs_at_least_32_bytes'
const BUCKET = 'recordings'
const OBJECT_KEY = `${ROOM}-test.mp4`

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The webhook auth LiveKit uses: HS256 JWT whose sha256 claim hashes the body. */
function livekitAuth(body) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({
    iss: API_KEY,
    nbf: now - 10,
    exp: now + 60,
    sha256: createHash('sha256').update(body).digest('base64'),
  }))
  const signature = base64url(
    createHmac('sha256', API_SECRET).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${signature}`
}

// --- Put a real object in the bucket, so playback has something to fetch.
sh(`${COMPOSE} exec -T minio sh -c "printf 'fake-mp4-body' > /tmp/${OBJECT_KEY}"`)
sh(`${COMPOSE} exec -T minio sh -c "mc alias set local http://localhost:9000 warroom warroomsecret >/dev/null 2>&1 || true; `
  + `mc cp /tmp/${OBJECT_KEY} local/${BUCKET}/${OBJECT_KEY}"`)
ok(true, 'a recording object exists in the bucket')

// --- Deliver the completion webhook exactly as Egress would.
const startedAt = (Date.now() - 65_000) * 1_000_000
const endedAt = Date.now() * 1_000_000
const body = JSON.stringify({
  event: 'egress_ended',
  egressInfo: {
    egressId: 'EG_' + RUN_ID,
    roomName: ROOM,
    startedAt,
    endedAt,
    fileResults: [{
      filename: OBJECT_KEY,
      location: `http://minio:9000/${BUCKET}/${OBJECT_KEY}`,
      size: 13,
      duration: 65_000 * 1_000_000,
    }],
  },
})
const webhook = await fetch(`${ORIGIN}/api/livekit/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/webhook+json', Authorization: livekitAuth(body) },
  body,
})
ok(webhook.ok, `the signed completion webhook is accepted (HTTP ${webhook.status})`)

// --- It appears in the room's library.
await sleep(1000)
const listed = await (await fetch(`${ORIGIN}/api/recordings/${ROOM}`)).json()
ok(listed.length === 1, `the recording is listed for its room (${listed.length})`)
ok(listed[0].durationMs === 65_000, `duration is carried through (${listed[0].durationMs}ms)`)
ok(listed[0].sizeBytes === 13, `size is carried through (${listed[0].sizeBytes} bytes)`)

// --- A redelivered webhook must not duplicate it.
await fetch(`${ORIGIN}/api/livekit/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/webhook+json', Authorization: livekitAuth(body) },
  body,
})
await sleep(1000)
const afterReplay = await (await fetch(`${ORIGIN}/api/recordings/${ROOM}`)).json()
ok(afterReplay.length === 1, 'a redelivered webhook does not duplicate the recording')

// --- Playback: a presigned URL that actually serves the object through nginx.
const { url, expiresInSeconds } = await (await fetch(
  `${ORIGIN}/api/recordings/${ROOM}/${listed[0].id}/url`)).json()
ok(url.includes('X-Amz-Signature='), 'playback hands back a presigned URL')
ok(!url.includes('warroomsecret'), 'the object store secret is not in the URL')
ok(Number(expiresInSeconds) > 0 && Number(expiresInSeconds) <= 3600,
  `the URL is short-lived (${expiresInSeconds}s)`)

const playback = await fetch(ORIGIN + url)
ok(playback.ok, `the presigned URL plays through the proxy (HTTP ${playback.status})`)
ok((await playback.text()) === 'fake-mp4-body', 'and returns the recording bytes')

// --- A tampered signature must not.
const tampered = await fetch(ORIGIN + url.replace(/X-Amz-Signature=.*/, 'X-Amz-Signature=deadbeef'))
ok(!tampered.ok, `a tampered signature is refused (HTTP ${tampered.status})`)

// --- The list is a page, not the whole table.
const paged = await (await fetch(`${ORIGIN}/api/recordings/${ROOM}?limit=0&offset=-1`)).json()
ok(Array.isArray(paged) && paged.length === 1,
  'nonsense paging is clamped rather than turned into a database error')
const beyond = await (await fetch(`${ORIGIN}/api/recordings/${ROOM}?limit=10&offset=5`)).json()
ok(beyond.length === 0, 'an offset past the end returns an empty page, not everything')

// --- Deletion removes the row AND the object.
const objectExists = () => {
  const out = sh(`${COMPOSE} exec -T minio sh -c "mc ls local/${BUCKET}/${OBJECT_KEY} 2>&1 || true"`)
  return out.includes(OBJECT_KEY)
}
ok(objectExists(), 'the object is still in the bucket before deletion')

const removed = await fetch(`${ORIGIN}/api/recordings/${ROOM}/${listed[0].id}`, { method: 'DELETE' })
ok(removed.ok, `the recording is deleted (HTTP ${removed.status})`)

const afterDelete = await (await fetch(`${ORIGIN}/api/recordings/${ROOM}`)).json()
ok(afterDelete.length === 0, 'it is gone from the room library')
// The whole point of deletion is that the file stops existing — a row-only
// delete would leave someone's meeting in the bucket forever.
ok(!objectExists(), 'and its object is gone from the bucket')

// --- A presigned URL minted before the deletion no longer serves anything.
const afterGone = await fetch(ORIGIN + url)
ok(!afterGone.ok, `a URL issued earlier now fails (HTTP ${afterGone.status})`)

// --- Deleting it again is a 404, not a second success.
const again = await fetch(`${ORIGIN}/api/recordings/${ROOM}/${listed[0].id}`, { method: 'DELETE' })
ok(again.status === 404, `deleting a recording that is gone 404s (HTTP ${again.status})`)

done('RECORDINGS')
