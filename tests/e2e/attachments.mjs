// Shared files: upload straight to the object store, list, download, delete.
// Needs the sfu + recording overlays (they bring the object store this reuses).
//
//   docker compose -f docker-compose.yml -f docker-compose.sfu.yml \
//     -f docker-compose.recording.yml up -d
//   tests/e2e/run.sh attachments
//
// The interesting property is that the backend never sees a file byte: the
// upload PUT and the download GET both go to the object store through nginx,
// carrying a signature the backend minted. So this suite uploads the way a
// browser does — to the signed URL — rather than posting to the API.
import { ORIGIN, RUN_ID, done, ok, signalClient } from './lib.mjs'

const ROOM = 'att-' + RUN_ID
const BODY = 'shared-file-body-' + RUN_ID
const json = (res) => res.json()

const post = (path, body) => fetch(`${ORIGIN}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// --- Sign an upload. The key is the server's choice, not ours.
const signed = await post(`/api/attachments/${ROOM}/upload-url`, {
  filename: 'plan.txt',
  contentType: 'text/plain',
  sizeBytes: BODY.length,
})
ok(signed.ok, `an upload URL is signed (HTTP ${signed.status})`)
const { uploadUrl, objectKey } = await json(signed)
ok(objectKey.startsWith(`attachments/${ROOM}/`),
  `the key is scoped to the room (${objectKey})`)
ok(!uploadUrl.includes('warroomsecret'), 'the object store secret is not in the URL')

// --- Upload to the store itself, through the proxy. Nothing goes to the API.
const put = await fetch(ORIGIN + uploadUrl, {
  method: 'PUT',
  headers: { 'content-type': 'text/plain' },
  body: BODY,
})
ok(put.ok, `the file uploads straight to the object store (HTTP ${put.status})`)

// --- Confirm, which is what creates the row.
const confirmed = await post(`/api/attachments/${ROOM}`, {
  objectKey,
  filename: 'plan.txt',
  contentType: 'text/plain',
})
ok(confirmed.ok, `the upload is confirmed (HTTP ${confirmed.status})`)
const created = await json(confirmed)
// The size comes from the store, not from what we claimed — that is the only
// number a limit can honestly be enforced against.
ok(created.sizeBytes === BODY.length,
  `the recorded size is the stored one (${created.sizeBytes} = ${BODY.length})`)

// --- A confirmation replayed after a dropped response must not list it twice.
await post(`/api/attachments/${ROOM}`, {
  objectKey, filename: 'plan.txt', contentType: 'text/plain',
})
const listed = await json(await fetch(`${ORIGIN}/api/attachments/${ROOM}`))
ok(listed.length === 1, `a replayed confirmation does not duplicate the file (${listed.length})`)

// --- A key from another room cannot be listed into this one.
const stolen = await post(`/api/attachments/${ROOM}`, {
  objectKey: 'attachments/some-other-room/deadbeef-secret.txt',
  filename: 'secret.txt',
  contentType: 'text/plain',
})
ok(stolen.status === 400,
  `a key from another room is refused (HTTP ${stolen.status})`)

// --- Confirming a key nothing was uploaded to is refused, not recorded as empty.
const phantom = await post(`/api/attachments/${ROOM}`, {
  objectKey: `attachments/${ROOM}/never-uploaded.txt`,
  filename: 'ghost.txt',
  contentType: 'text/plain',
})
ok(phantom.status === 404, `a key with no object behind it is refused (HTTP ${phantom.status})`)

// --- Paging, same contract as every other list endpoint.
const clamped = await json(await fetch(`${ORIGIN}/api/attachments/${ROOM}?limit=0&offset=-1`))
ok(clamped.length === 1, 'nonsense paging is clamped rather than turned into an error')
const beyond = await json(await fetch(`${ORIGIN}/api/attachments/${ROOM}?limit=10&offset=5`))
ok(beyond.length === 0, 'an offset past the end returns an empty page')

// --- Download: a fresh presigned GET that really serves the bytes.
const { url } = await json(await fetch(`${ORIGIN}/api/attachments/${ROOM}/${created.id}/url`))
ok(url.includes('X-Amz-Signature='), 'download hands back a presigned URL')
const fetched = await fetch(ORIGIN + url)
ok(fetched.ok, `the presigned URL serves the file through the proxy (HTTP ${fetched.status})`)
ok((await fetched.text()) === BODY, 'and returns exactly the bytes that were uploaded')

// --- The room is told, so other participants' lists refresh without polling.
const watcher = signalClient('watcher', 'Watcher')
await watcher.join(ROOM)
await watcher.next('room-state')
await post(`/api/attachments/${ROOM}/upload-url`, {
  filename: 'second.txt', contentType: 'text/plain', sizeBytes: 5,
}).then(json).then(async ({ uploadUrl: second, objectKey: secondKey }) => {
  await fetch(ORIGIN + second, { method: 'PUT', body: 'hello' })
  await post(`/api/attachments/${ROOM}`, {
    objectKey: secondKey, filename: 'second.txt', contentType: 'text/plain',
  })
})
const announced = await watcher.next('attachment', 10000)
ok(announced.payload?.filename === 'second.txt',
  `the room is told about a new file over signaling (${announced.payload?.filename})`)
watcher.close()

// --- Deletion removes the row AND the object.
const removed = await fetch(`${ORIGIN}/api/attachments/${ROOM}/${created.id}`, { method: 'DELETE' })
ok(removed.ok, `the file is deleted (HTTP ${removed.status})`)
const afterDelete = await json(await fetch(`${ORIGIN}/api/attachments/${ROOM}`))
ok(!afterDelete.some((f) => f.id === created.id), 'it is gone from the room list')
const afterGone = await fetch(ORIGIN + url)
ok(!afterGone.ok, `a URL issued earlier now fails (HTTP ${afterGone.status})`)

done('ATTACHMENTS')
