// The workspace layout, and the skin it wears.
//
// Nothing here can be checked without a browser: media queries, whether a
// control is reachable, whether anything spills off the side, whether the
// document really carries the theme the clock chose.
//
// The sidebar holds up to seven panels. Stacking them puts the chat box several
// screens below the video — exactly where nobody scrolls during a call — and on
// a desktop a 320px rail gives each panel a sliver. So one is open at a time, at
// every width, and the tab strip chooses which.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-layout-' + RUN_ID
const DESKTOP = { width: 1280, height: 900 }
// iPhone-ish portrait: the narrowest thing anyone will realistically use.
const PHONE = { width: 390, height: 780 }

const browser = await launch()
const page = await joinRoom(browser, { room, name: 'Mobile' })
await sleep(2000)

// --- One panel at a time, on a desktop as much as on a phone.
for (const [label, size] of [['a wide screen', DESKTOP], ['a narrow screen', PHONE]]) {
  await page.setViewportSize(size)
  await sleep(300)
  ok(await page.locator('.sidebar__tabs').isVisible(), `${label} offers the tab strip`)
  const visible = await page.locator('.sidebar__panel:visible').count()
  ok(visible === 1, `${label} shows exactly one panel (${visible})`)
}

ok(await page.locator('.chat').isVisible(),
  'chat is the one it opens on — the panel people keep open')

const tabs = await page.locator('.sidebar__tab').allInnerTexts()
ok(tabs.includes('成員') && tabs.includes('聊天'),
  `the tabs name the panels that exist (${tabs.join('/')})`)
// A tab for a panel that is not rendered would switch to a blank sidebar.
const panels = await page.locator('.sidebar__panel').count()
ok(tabs.length === panels, `no tab points at a panel that is not there (${tabs.length}/${panels})`)

await page.locator('.sidebar__tab', { hasText: '成員' }).click()
await sleep(200)
ok(await page.locator('.members').isVisible(), 'switching tabs shows the other panel')
ok(!(await page.locator('.chat').isVisible()), 'and hides the previous one')

// --- Nothing spills off the side. A horizontal scrollbar on a phone means
//     something is laid out for a screen that is not there.
const overflow = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  win: window.innerWidth,
}))
ok(overflow.doc <= overflow.win + 1,
  `the page does not scroll sideways (${overflow.doc} vs ${overflow.win})`)

// --- The video tiles still get a usable width rather than collapsing.
const tile = await page.locator('.video-tile').first().boundingBox()
ok(tile !== null && tile.width >= 150, `video tiles stay legible (${Math.round(tile?.width ?? 0)}px)`)

// --- The skin. `auto` follows the local clock; an explicit choice overrides it
//     and survives a reload, which is the whole reason the choice is stored.
await page.setViewportSize(DESKTOP)
const themeNow = () => page.evaluate(() => document.documentElement.dataset.theme)
ok(['day', 'night'].includes(await themeNow()),
  `the document carries a skin from the first paint (${await themeNow()})`)

await page.locator('.skin__btn', { hasText: '日' }).first().click()
await sleep(200)
ok((await themeNow()) === 'day', 'choosing 日 puts the room in the day skin')
const dayBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

await page.locator('.skin__btn', { hasText: '夜' }).first().click()
await sleep(200)
ok((await themeNow()) === 'night', 'and 夜 puts it in the night skin')
const nightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
ok(dayBg !== nightBg, `the two skins really are different surfaces (${dayBg} vs ${nightBg})`)

// Video stays black in both, or the letterboxing glows white around a face.
const tileBg = await page.evaluate(
  () => getComputedStyle(document.querySelector('.video-tile')).backgroundColor)
await page.locator('.skin__btn', { hasText: '日' }).first().click()
await sleep(200)
const tileBgDay = await page.evaluate(
  () => getComputedStyle(document.querySelector('.video-tile')).backgroundColor)
ok(tileBg === tileBgDay, `the video tile stays the same black in both skins (${tileBgDay})`)

await page.reload()
await sleep(1500)
ok((await themeNow()) === 'day', 'and the choice survives a reload')

// --- The split is the user's. Nothing here can be checked without a real
//     pointer: the drag, whether the video reflows, whether it is remembered.
await sleep(1500)
const sidebarWidth = () =>
  page.locator('.sidebar').boundingBox().then((b) => Math.round(b?.width ?? 0))

const before = await sidebarWidth()
const handle = await page.locator('.divider').boundingBox()
await page.mouse.move(handle.x + 5, handle.y + 60)
await page.mouse.down()
await page.mouse.move(handle.x - 300, handle.y + 60, { steps: 10 })
await page.mouse.up()
await sleep(300)

const dragged = await sidebarWidth()
// An earlier version re-registered its listeners on every move, and the cleanup
// ended the drag: the divider moved one step and let go.
ok(dragged > before + 200,
  `dragging the divider really widens the panel (${before} → ${dragged})`)

const tile = await page.locator('.video-tile').first().boundingBox()
ok(tile.width < 900, `and the video gives up the width it took (${Math.round(tile.width)}px)`)

await page.reload()
await sleep(2500)
const remembered = await sidebarWidth()
ok(Math.abs(remembered - dragged) < 20,
  `the split is remembered across a reload (${dragged} → ${remembered})`)

// Keyboard, because a layout adjustable by pointer only is adjustable by some
// people only.
await page.locator('.divider').focus()
await page.keyboard.press('ArrowRight')
await sleep(200)
ok((await sidebarWidth()) < remembered, 'and the arrow keys move it too')

// --- Tile size, independent of the split.
const gridWidth = await page.locator('.video-grid').boundingBox().then((b) => b.width)
const smallTile = await page.locator('.video-tile').first().boundingBox()
await page.getByLabel('放大視訊').click()
await sleep(250)
const bigTile = await page.locator('.video-tile').first().boundingBox()
ok(bigTile.width > smallTile.width || gridWidth < 400,
  `the zoom control resizes the tiles (${Math.round(smallTile.width)} → ${Math.round(bigTile.width)})`)

await browser.close()
done('UI-LAYOUT')
