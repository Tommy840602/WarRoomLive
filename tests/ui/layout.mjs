// The layout on a phone-sized screen. Nothing here can be checked without a
// browser: media queries, whether a control is reachable, whether anything
// spills off the side.
//
// The specific worry is the sidebar. It holds five panels, and stacking them on
// a 390px screen puts the chat box several screens below the video — which is
// exactly where nobody scrolls during a call. Below the breakpoint they become
// one at a time.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-layout-' + RUN_ID
// iPhone-ish portrait: the narrowest thing anyone will realistically use.
const PHONE = { width: 390, height: 780 }

const browser = await launch()
const page = await joinRoom(browser, { room, name: 'Mobile' })
await sleep(2000)

// --- Wide: every panel is visible at once and the tab strip is not shown.
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(300)
const wideVisible = await page.locator('.sidebar__panel:visible').count()
ok(wideVisible >= 2, `a wide screen shows every panel at once (${wideVisible})`)
ok(!(await page.locator('.sidebar__tabs').isVisible()),
  'and offers no tab strip, because there is nothing to switch between')

// --- Narrow: one panel, chosen by the tabs.
await page.setViewportSize(PHONE)
await sleep(300)
ok(await page.locator('.sidebar__tabs').isVisible(), 'a narrow screen offers the tab strip')
ok(await page.locator('.sidebar__panel:visible').count() === 1,
  'and shows exactly one panel')
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

await browser.close()
done('UI-LAYOUT')
