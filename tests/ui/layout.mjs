// The workspace: the panels, the split, and the skin.
//
// Nothing here can be checked without a browser and a real pointer: media
// queries, whether a drag actually moves anything, whether a control is
// reachable, whether anything spills off the side.
//
// The sidebar holds up to seven panels. Stacking them puts the chat box several
// screens below the video — exactly where nobody scrolls during a call — and on
// a desktop a 320px rail gives each panel a sliver. So one is open at a time, at
// every width, and the tab strip chooses which.
//
// **Order matters here.** The last checks reload the page, and a reload drops
// out of the room: no video tiles, no zoom control. So everything needing the
// room runs first. Getting this wrong does not fail honestly — it times out
// looking for an element that was never going to be there.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-layout-' + RUN_ID
const DESKTOP = { width: 1280, height: 900 }
// iPhone-ish portrait: the narrowest thing anyone will realistically use.
const PHONE = { width: 390, height: 780 }
/** Longer than the skin crossfade, or the colour read back is mid-transition. */
const FADE_MS = 600

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
const phoneTile = await page.locator('.video-tile').first().boundingBox()
ok(phoneTile !== null && phoneTile.width >= 150,
  `video tiles stay legible on a phone (${Math.round(phoneTile?.width ?? 0)}px)`)

await page.setViewportSize(DESKTOP)
await sleep(500)

// --- The skin, while there is still a room to look at.
const themeNow = () => page.evaluate(() => document.documentElement.dataset.theme)
ok(['day', 'night'].includes(await themeNow()),
  `the document carries a skin from the first paint (${await themeNow()})`)

const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const tileBg = () =>
  page.evaluate(() => getComputedStyle(document.querySelector('.video-tile')).backgroundColor)

await page.locator('.skin__btn', { hasText: '日' }).first().click()
await sleep(FADE_MS)
ok((await themeNow()) === 'day', 'choosing 日 puts the room in the day skin')
const dayBg = await bodyBg()
const dayTile = await tileBg()

await page.locator('.skin__btn', { hasText: '夜' }).first().click()
await sleep(FADE_MS)
ok((await themeNow()) === 'night', 'and 夜 puts it in the night skin')
const nightBg = await bodyBg()
ok(dayBg !== nightBg, `the two skins really are different surfaces (${dayBg} vs ${nightBg})`)

// Video stays black in both, or the letterboxing glows white around a face.
ok(dayTile === (await tileBg()), `the video tile stays the same black in both skins (${dayTile})`)

// --- Every control has to be readable, in both skins.
//
// This is the check that would have caught the worst bug in this file's
// history: `.app__controls button` painted every button with `--accent-ink` —
// the colour that goes ON the accent — and a secondary button swapped only the
// background. The result was dark-on-dark at night and, in day, white text on a
// white button, measured at 1.04:1. Every existing suite passed: the buttons
// were present, clickable, correctly labelled and completely invisible.
//
// So this measures what was actually painted, rather than what class was
// applied. Contrast is computed from the resolved colours the way WCAG defines
// it; 4.5:1 is the AA threshold for body text.
const contrastOfControls = () =>
  page.evaluate(() => {
    const lin = (c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    /** Walks up for the first non-transparent background, as the eye does. */
    const groundOf = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor
        const parts = parse(bg)
        const alpha = (bg.match(/[\d.]+/g) || [])[3]
        if (parts.length === 3 && alpha !== '0') return parts
      }
      return [0, 0, 0]
    }
    return [...document.querySelectorAll('.app__controls button')].map((el) => {
      const ink = parse(getComputedStyle(el).color)
      const ground = groundOf(el)
      const a = lum(ink)
      const b = lum(ground)
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      return { label: el.textContent.trim().slice(0, 12), ratio: Math.round(ratio * 100) / 100 }
    })
  })

const nightContrast = await contrastOfControls()
const nightWorst = nightContrast.reduce((w, c) => (c.ratio < w.ratio ? c : w))
ok(nightWorst.ratio >= 4.5,
  `every control is readable in the night skin (worst: ${nightWorst.label} at ${nightWorst.ratio}:1)`)

await page.locator('.skin__btn', { hasText: '日' }).first().click()
await sleep(FADE_MS)
const dayContrast = await contrastOfControls()
const dayWorst = dayContrast.reduce((w, c) => (c.ratio < w.ratio ? c : w))
ok(dayWorst.ratio >= 4.5,
  `and in the day skin (worst: ${dayWorst.label} at ${dayWorst.ratio}:1)`)

await page.locator('.skin__btn', { hasText: '夜' }).first().click()
await sleep(FADE_MS)

// --- The split is the user's, and only a real pointer can check it.
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

const shrunk = await page.locator('.video-grid').boundingBox()
ok(shrunk.width < 1280 - dragged,
  `and the video gives up the width it took (${Math.round(shrunk.width)}px)`)

// --- Tile size, independent of the split. With `1fr` columns the tile stretched
//     to fill the row, so this control changed nothing a viewer could see.
const smallTile = await page.locator('.video-tile').first().boundingBox()
await page.getByLabel('放大視訊').click()
await sleep(300)
const bigTile = await page.locator('.video-tile').first().boundingBox()
ok(bigTile.width > smallTile.width,
  `the zoom control resizes the tiles (${Math.round(smallTile.width)} → ${Math.round(bigTile.width)})`)

await page.getByLabel('縮小視訊').click()
await sleep(300)
const backDown = await page.locator('.video-tile').first().boundingBox()
ok(Math.abs(backDown.width - smallTile.width) < 4, 'and back down again')

// --- Everything past here reloads, which leaves the room.
await page.reload()
await sleep(2500)

const remembered = await sidebarWidth()
ok(Math.abs(remembered - dragged) < 20,
  `the split is remembered across a reload (${dragged} → ${remembered})`)
ok((await themeNow()) === 'night', 'and so is the skin')

// Keyboard, because a layout adjustable by pointer only is adjustable by some
// people only.
await page.locator('.divider').focus()
await page.keyboard.press('ArrowRight')
await sleep(250)
ok((await sidebarWidth()) < remembered, 'the arrow keys move the divider too')

await browser.close()
done('UI-LAYOUT')
