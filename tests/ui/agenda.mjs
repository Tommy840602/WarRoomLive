// The room's agenda board, as two participants use it together.
// Needs a database, which the base stack has.
//
// What only a browser answers: does a change one person makes reach the other
// *without a reload* (it travels over signaling, not polling), does the board
// they both see agree, does the one-line capture put the right fields on the
// wire — and, the thing this redesign is actually about, does a triage decision
// made by one person hold for the room rather than living in one browser.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-agenda-' + RUN_ID
const agenda = (page) => page.locator('[data-panel="agenda"]')

const open = async (page) => {
  await page.locator('.sidebar__tab', { hasText: '議程' }).click()
  await agenda(page).locator('.capture__line').waitFor({ state: 'visible' })
}

/**
 * The whole item, as one line — the point of the capture.
 *
 * The button is only enabled once React has parsed the line, so wait for that
 * rather than clicking into a 30-second actionability timeout that reports
 * "not enabled" and says nothing about why.
 */
const capture = async (page, line) => {
  await agenda(page).locator('.capture__line').fill(line)
  await agenda(page).locator('.capture__go:not([disabled])').waitFor({ timeout: 10000 })
  await agenda(page).locator('.capture__go').click()
  // The panel clears the line only after the write and its refetch, so the
  // preview outlives the new row for a moment. Anything counting chips has to
  // let that settle or it counts the preview's.
  await agenda(page).locator('.capture__line').filter({ hasNotText: /./ }).first()
    .waitFor({ timeout: 15000 }).catch(() => {})
  await page.waitForFunction(
    () => (document.querySelector('[data-panel="agenda"] .capture__line')?.value ?? '') === '',
    null, { timeout: 15000 })
}

/** Which band a piece of text ended up in. */
const bandOf = (page, text) =>
  page.evaluate((t) => {
    const band = [...document.querySelectorAll('[data-panel="agenda"] .band')]
      .find((b) => b.textContent?.includes(t))
    return band?.querySelector('.band__label')?.textContent?.replace(/\d+$/, '') ?? null
  }, text)

const waitBand = (page, text, label) =>
  page.waitForFunction(
    ([t, l]) => {
      const band = [...document.querySelectorAll('[data-panel="agenda"] .band')]
        .find((b) => b.textContent?.includes(t))
      return band?.querySelector('.band__label')?.textContent?.replace(/\d+$/, '') === l
    },
    [text, label],
    { timeout: 15000 },
  )

const rowCount = (page) =>
  page.evaluate(() => document.querySelectorAll('[data-panel="agenda"] .row').length)

/**
 * Presses the triage control of the item with this text.
 *
 * By name, never by position: the bands reorder as items move between them, so
 * "the first triage button" is a different item after every press.
 */
const pressTriage = (page, text) =>
  page.locator('[data-panel="agenda"] .row', { hasText: text }).locator('.triage').click()

const browser = await launch()
const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(2000)

const tabs = await alice.locator('.sidebar__tab').allInnerTexts()
ok(tabs.includes('議程'), `the room offers one agenda, not a list and a calendar (${tabs.join('/')})`)
ok(!tabs.includes('待辦') && !tabs.includes('行事曆'),
  'and does not still offer the two panels it replaced')

await open(alice)
await open(bob)

// --- A task and an appointment, from one input, landing on one board.
//
// The times are relative on purpose. An earlier version captured
// `明天14:00-15:00` and asserted it landed in 現在, which is true only when the
// suite runs after 14:00 — it passed all afternoon and failed at ten to one in
// the morning. Nothing about the product had changed.
await capture(alice, '訂會議室 @Bob 3天後')
await alice.waitForFunction(
  () => document.querySelectorAll('[data-panel="agenda"] .row').length === 1, null,
  { timeout: 15000 })
await capture(alice, '與法務對齊 2小時後')
await alice.waitForFunction(
  () => document.querySelectorAll('[data-panel="agenda"] .row').length === 2, null,
  { timeout: 15000 })

ok((await agenda(alice).locator('.chip--who').allInnerTexts()).includes('@Bob'),
  'the assignee was lifted out of the line')
// The span is what stamps an item as an appointment; without it, a task. Its
// own item, so the band assertions above it can use relative times.
await capture(alice, '值班交接 22:00-23:00')
await alice.waitForFunction(
  () => document.querySelectorAll('[data-panel="agenda"] .row').length === 3, null,
  { timeout: 15000 })
// Scoped to the rows: the capture preview carries the same chip, and counting
// it would answer a different question.
const stamps = await agenda(alice).locator('.row .chip--stamp').allInnerTexts()
ok(stamps.length === 1 && stamps[0] === '約會',
  `only the line that named a span became an appointment (${stamps.join('/')})`)

// --- The clock does the filing until somebody disagrees.
ok((await bandOf(alice, '與法務對齊')) === '現在',
  'something happening in two hours is filed under 現在 by the clock')
ok((await bandOf(alice, '訂會議室')) === '稍後',
  'and something three days out under 稍後')

// --- Bob sees the same board without reloading.
await bob.waitForFunction(
  () => document.querySelectorAll('[data-panel="agenda"] .row').length === 3, null,
  { timeout: 15000 })
ok((await bandOf(bob, '與法務對齊')) === '現在',
  'the other participant sees the same board, without reloading')

// --- Triage is the room's decision, not one browser's. This is the whole
//     reason it is a database column and not component state.
await pressTriage(alice, '與法務對齊')
await waitBand(bob, '與法務對齊', '稍後')
ok(true, "one person's triage decision reaches everyone else")

// And it is visibly a decision now, not the clock still guessing.
const autoRings = await agenda(bob).locator('.triage--auto').count()
ok(autoRings === 2,
  `a decided item stops being marked as automatic (${autoRings} of 3 still automatic)`)

// --- Cycling round to 完成 records who did it.
await pressTriage(alice, '與法務對齊')
await waitBand(alice, '與法務對齊', '完成')
ok((await agenda(alice).locator('.chip--done').count()) >= 1,
  'finishing an item records who finished it')
await waitBand(bob, '與法務對齊', '完成')
ok(true, 'and that reaches the other participant too')

// --- The calendar is a time grid over the same items, not another list.
await agenda(alice).getByRole('button', { name: '行事曆' }).click()
await sleep(500)
ok(await agenda(alice).locator('.grid__column').count() >= 1,
  'the calendar view is a grid of day columns')
ok((await agenda(alice).locator('.slot').allInnerTexts()).some((t) => t.includes('與法務對齊')),
  'and the appointment captured on the board is a block on it')

// A block's height is its duration — the thing a list cannot show, and the
// reason a room can see whether an afternoon is free.
const spans = await alice.evaluate(() =>
  [...document.querySelectorAll('[data-panel="agenda"] .slot')]
    .map((el) => ({ text: el.textContent ?? '', height: el.getBoundingClientRect().height })))
// The one that named a span. The other items have no end and are correctly
// drawn at the minimum, so measuring those would prove nothing.
const hourLong = spans.find((s) => s.text.includes('值班交接'))
ok(hourLong && hourLong.height > 30,
  `an hour-long appointment is drawn an hour tall (${Math.round(hourLong?.height ?? 0)}px)`)

// The now-line is the one moving thing on the grid; without it the reader has
// to work out where "now" is from the hour labels.
ok(await agenda(alice).locator('.grid__now').count() === 1,
  'today carries a now-line, and only today')

// Paging away from today and back.
await agenda(alice).getByRole('button', { name: '下一段' }).click()
await sleep(300)
ok(await agenda(alice).locator('.grid__now').count() === 0, 'paging forward leaves today behind')
await agenda(alice).getByRole('button', { name: '今天' }).click()
await sleep(300)
ok(await agenda(alice).locator('.grid__now').count() === 1, 'and 今天 brings it back')

// An undated item cannot be placed on a grid, so it is counted rather than dropped.
await capture(alice, '沒有時間的事')
await sleep(600)
ok((await agenda(alice).innerText()).includes('沒有時間的項目'),
  'undated items are counted, not silently missing from the grid')

await agenda(alice).getByRole('button', { name: '清單' }).click()
await sleep(400)

// --- Deleting takes two presses, like everything else destructive here.
const del = agenda(alice)
  .locator('.row', { hasText: '訂會議室' })
  .locator('.row__drop')
await del.click()
ok((await del.innerText()).includes('確認'), 'the first press asks for confirmation')
ok((await rowCount(alice)) === 4, 'and nothing is deleted yet')

await del.click()
await bob.waitForFunction(
  () => document.querySelectorAll('[data-panel="agenda"] .row').length === 3, null,
  { timeout: 15000 })
ok(true, 'confirming removes it, for both participants')

await browser.close()
done('UI-AGENDA')
