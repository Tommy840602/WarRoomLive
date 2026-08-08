// The recording library as a participant sees it: a finished recording is
// listed in the room and plays in place. Needs the sfu + recording overlays.
//
// A completed recording is staged by delivering the webhook Egress would send
// (signed as LiveKit signs it) against a real object in the bucket — the same
// approach tests/e2e/recordings.mjs uses, so the browser has something to list
// without waiting on a compositor.
import { createHash, createHmac } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ORIGIN, RUN_ID, done, joinRoom, launch, ok, openPanel, sleep } from './lib.mjs'

const room = 'ui-rec-' + RUN_ID
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const COMPOSE = `docker compose -f ${REPO_ROOT}docker-compose.yml `
  + `-f ${REPO_ROOT}docker-compose.sfu.yml -f ${REPO_ROOT}docker-compose.recording.yml`
const API_KEY = 'devkey'
const API_SECRET = 'devkey_secret_needs_at_least_32_bytes'
const OBJECT_KEY = `${room}.mp4`

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function livekitAuth(body) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({
    iss: API_KEY, nbf: now - 10, exp: now + 60,
    sha256: createHash('sha256').update(body).digest('base64'),
  }))
  return `${header}.${payload}.`
    + base64url(createHmac('sha256', API_SECRET).update(`${header}.${payload}`).digest())
}

// A tiny but genuinely playable MP4 would need a real encoder; the panel only
// has to fetch and hand the URL to the element, so bytes are enough to prove
// the request path works end to end.
execSync(`${COMPOSE} exec -T minio sh -c "printf 'video-bytes' > /tmp/${OBJECT_KEY}; `
  + `mc alias set local http://localhost:9000 warroom warroomsecret >/dev/null 2>&1 || true; `
  + `mc cp /tmp/${OBJECT_KEY} local/recordings/${OBJECT_KEY}"`, { stdio: 'ignore' })

const body = JSON.stringify({
  event: 'egress_ended',
  egressInfo: {
    egressId: 'EG_UI_' + RUN_ID,
    roomName: room,
    startedAt: (Date.now() - 90_000) * 1_000_000,
    endedAt: Date.now() * 1_000_000,
    fileResults: [{
      filename: OBJECT_KEY,
      location: `http://minio:9000/recordings/${OBJECT_KEY}`,
      size: 11,
      duration: 90_000 * 1_000_000,
    }],
  },
})
const webhook = await fetch(`${ORIGIN}/api/livekit/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/webhook+json', Authorization: livekitAuth(body) },
  body,
})
ok(webhook.ok, 'a completed recording exists for the room')

const browser = await launch()
const page = await joinRoom(browser, { room, name: 'Viewer' })
await openPanel(page, '錄影', '.recordings')
await sleep(3000)

ok(await page.locator('.recordings').count() === 1, 'the room shows a recordings panel')
const items = page.locator('.recordings__item')
ok(await items.count() === 1, `the finished recording is listed (${await items.count()})`)
ok((await page.locator('.recordings__detail').innerText()).includes('1:30'),
  'its duration is shown in a readable form')

// Pressing play fetches a fresh URL and hands it to the element.
await page.locator('.recordings__play').first().click()
await page.waitForSelector('.recordings__player', { timeout: 10000 })
const src = await page.locator('.recordings__player').getAttribute('src')
ok(!!src && src.includes('X-Amz-Signature='), 'playing loads a presigned URL into the player')
ok(!src.includes('warroomsecret'), 'the object store secret is not exposed to the page')

// And that URL really serves the object from the browser's own origin.
const status = await page.evaluate(async (u) => (await fetch(u)).status, src)
ok(status === 200, `the player's URL is fetchable from the page (HTTP ${status})`)

// Deleting is irreversible, so the first press must only arm the control.
const del = page.locator('.recordings__delete').first()
await del.click()
ok((await del.innerText()).includes('確認'), 'the first press asks for confirmation instead of deleting')
ok(await items.count() === 1, 'and the recording is still there')

await del.click()
await page.waitForFunction(
  () => document.querySelectorAll('.recordings__item').length === 0, null, { timeout: 10000 })
ok(true, 'confirming removes it from the list')
// The list is refetched, so an empty panel means the server really lost it.
const remaining = await page.evaluate(
  async (r) => (await (await fetch(`/api/recordings/${r}`)).json()).length, room)
ok(remaining === 0, 'and the server agrees it is gone, not just the local view')

await browser.close()
done('UI-RECORDINGS')
