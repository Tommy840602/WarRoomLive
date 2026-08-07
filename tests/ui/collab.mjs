// The collaboration panel through the UI: typing in the shared notes reaches
// the other participant, and a stroke drawn on the whiteboard shows up on
// their canvas. The CRDT e2e suite proves the documents converge; this proves
// the editors are actually wired to them.
import { RUN_ID, canvasInk, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-collab-' + RUN_ID
const browser = await launch()

const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(4000)

// --- Shared notes.
const marker = 'notes-' + RUN_ID
await alice.locator('.ProseMirror').click()
await alice.keyboard.type(marker)
await sleep(4000)
ok((await bob.locator('.ProseMirror').innerText()).includes(marker),
  'a note typed by one participant appears for the other')

// --- Whiteboard.
for (const page of [alice, bob]) {
  await page.locator('button:has-text("白板")').first().click()
  await page.waitForSelector('canvas', { timeout: 10000 })
}
await sleep(2000)
ok(await canvasInk(bob) < 100, 'the board starts empty for the second participant')

// Mouse coordinates are viewport-relative, and the board sits below the video
// grid — whose height depends on how many people are in the room. Scroll it
// into view first, then take the box, or the drag lands on nothing.
const canvas = alice.locator('canvas').first()
await canvas.scrollIntoViewIfNeeded()
const box = await canvas.boundingBox()
await alice.mouse.move(box.x + 60, box.y + 60)
await alice.mouse.down()
for (let i = 1; i < 12; i++) {
  await alice.mouse.move(box.x + 60 + i * 14, box.y + 60 + i * 6)
  await sleep(20)
}
await alice.mouse.up()
await sleep(4000)

ok(await canvasInk(alice) > 100, 'the stroke is drawn on the author\'s canvas')
ok(await canvasInk(bob) > 100, "the stroke reaches the other participant's canvas")

await browser.close()
done('UI-COLLAB')
