// Sharing a file, as a participant does it: pick a file, watch it upload, see
// it appear for the *other* person, download it back. Needs the sfu + recording
// overlays (the object store this reuses).
//
// The browser is what makes this worth running: the upload goes straight from
// the page to the object store through a presigned URL, so the only place that
// path can be checked as a whole is a page that actually performs it.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-files-' + RUN_ID
const CONTENT = 'shared-by-the-browser-' + RUN_ID

const browser = await launch()
const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(2000)

ok(await alice.locator('.files').count() === 1, 'the room offers a files panel')

// --- Upload from the page itself.
await alice.setInputFiles('.files__input', {
  name: 'plan.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from(CONTENT),
})
await alice.waitForSelector('.files__item', { timeout: 20000 })
ok(true, 'the uploaded file appears in the uploader\'s list')

const detail = await alice.locator('.files__detail').first().innerText()
ok(detail.includes('KB'), `its size is shown in a readable form (${detail})`)

// --- The other participant is told over signaling, without reloading.
await bob.waitForSelector('.files__item', { timeout: 20000 })
const bobName = await bob.locator('.files__name').first().innerText()
ok(bobName === 'plan.txt', `the other participant sees it appear live (${bobName})`)

// --- Download: a fresh presigned URL that really serves the bytes, fetched
//     from the page so the whole browser path is exercised.
const url = await bob.evaluate(async (r) => {
  const list = await (await fetch(`/api/attachments/${r}`)).json()
  const res = await fetch(`/api/attachments/${r}/${list[0].id}/url`)
  return (await res.json()).url
}, room)
ok(url.includes('X-Amz-Signature='), 'the download URL is presigned')
ok(!url.includes('warroomsecret'), 'no object-store secret is anywhere in the page')

const body = await bob.evaluate(async (u) => (await fetch(u)).text(), url)
ok(body === CONTENT, 'and it returns exactly what was uploaded')

// --- Deleting takes two presses, like recordings.
const del = bob.locator('.files__delete').first()
await del.click()
ok((await del.innerText()).includes('確認'), 'the first press asks for confirmation')
ok(await bob.locator('.files__item').count() === 1, 'and the file is still there')

await del.click()
await bob.waitForFunction(
  () => document.querySelectorAll('.files__item').length === 0, null, { timeout: 15000 })
ok(true, 'confirming removes it')

await browser.close()
done('UI-FILES')
