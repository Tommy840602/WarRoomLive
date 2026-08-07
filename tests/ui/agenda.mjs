// The shared to-do list and calendar as two participants use them together.
// Needs a database, which the base stack has.
//
// What only a browser answers: does a change one person makes reach the other
// *without a reload* (it travels over signaling, not polling), does the list
// they both see agree — including the ordering, which the server owns — and
// does the one-line capture actually put the right fields on the wire.
//
// Every locator is scoped to its panel. Both panels are in the DOM at once and
// the CSS only hides the inactive one, so an unscoped `.row` would count rows
// from the calendar while claiming to count to-dos.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-agenda-' + RUN_ID

const panel = (page, name) => page.locator(`[data-panel="${name}"]`)

/** Opens a sidebar panel. One panel is shown at a time, at every width. */
const open = async (page, name, label) => {
  await page.locator('.sidebar__tab', { hasText: label }).click()
  await panel(page, name).locator('.capture__line').waitFor({ state: 'visible' })
}

/** The whole item, as one line — the point of the redesign. */
const capture = async (page, name, line) => {
  await panel(page, name).locator('.capture__line').fill(line)
  await panel(page, name).locator('.capture__go').click()
}

const rowCount = (page, name) =>
  page.evaluate((n) => document.querySelectorAll(`[data-panel="${n}"] .row`).length, name)

const waitRows = (page, name, count) =>
  page.waitForFunction(
    ([n, c]) => document.querySelectorAll(`[data-panel="${n}"] .row`).length === c,
    [name, count],
    { timeout: 15000 },
  )

const browser = await launch()
const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(2000)

const tabs = await alice.locator('.sidebar__tab').allInnerTexts()
ok(tabs.includes('待辦'), 'the room offers a shared to-do list')
ok(tabs.includes('行事曆'), 'and a shared calendar')

await open(alice, 'todos', '待辦')
await open(bob, 'todos', '待辦')

// --- Alice adds two items from one line each, the later-due one first.
//     `3天後` / `2小時後` are the point: nobody fills in a datetime picker
//     while someone is still talking.
await capture(alice, 'todos', '訂會議室 @Bob 3天後')
await waitRows(alice, 'todos', 1)
await capture(alice, 'todos', '寄簡報 2小時後')
await waitRows(alice, 'todos', 2)

const aliceOrder = await panel(alice, 'todos').locator('.row__text').allInnerTexts()
ok(aliceOrder.join(',') === '寄簡報,訂會議室',
  `the soonest-due item is listed first (${aliceOrder.join(',')})`)

// The assignee and the due date came out of the same line, not extra fields.
ok((await panel(alice, 'todos').locator('.chip--who').allInnerTexts()).includes('@Bob'),
  'the assignee was lifted out of the line')
const rail = await panel(alice, 'todos').locator('.row__when').allInnerTexts()
ok(rail.some((t) => t.includes('小時後')) && rail.some((t) => t.includes('天後')),
  `each row leads with how far off it is (${rail.join('/')})`)

// --- Bob sees them appear without reloading: the change came over signaling.
await waitRows(bob, 'todos', 2)
const bobOrder = await panel(bob, 'todos').locator('.row__text').allInnerTexts()
ok(bobOrder.join(',') === aliceOrder.join(','),
  'the other participant sees the same list, in the same order, without reloading')

// --- Bob ticks one off; Alice sees it, and it sinks below what is still open.
await panel(bob, 'todos').locator('.row__check').first().click()
await alice.waitForFunction(
  () => document.querySelectorAll('[data-panel="todos"] .row--done').length === 1,
  null, { timeout: 15000 })
ok(true, 'completing an item reaches the other participant')

const afterDone = await panel(alice, 'todos').locator('.row__text').allInnerTexts()
ok(afterDone[afterDone.length - 1] === '寄簡報',
  `a completed item sinks below what is still open (${afterDone.join(',')})`)

// --- The calendar, same round trip and the same capture line.
await open(alice, 'calendar', '行事曆')
await open(bob, 'calendar', '行事曆')
await capture(alice, 'calendar', '週會 3小時後')

await waitRows(bob, 'calendar', 1)
const title = await panel(bob, 'calendar').locator('.row__text').first().innerText()
ok(title === '週會', `a calendar entry reaches the other participant live (${title})`)
// Grouped under a day heading, because "which day" is the first question.
ok(await panel(bob, 'calendar').locator('.day__label').count() >= 1,
  'and is grouped under the day it falls on')

// A line with no time cannot be placed on a calendar; it says so rather than
// leaving a dead button with no explanation.
await panel(alice, 'calendar').locator('.capture__line').fill('沒有時間的事')
ok(await panel(alice, 'calendar').locator('.capture__read--needs').isVisible(),
  'an entry with no time asks for one instead of failing silently')
await panel(alice, 'calendar').locator('.capture__line').fill('')

// --- Deleting takes two presses, like everything else destructive here.
await open(alice, 'todos', '待辦')
await open(bob, 'todos', '待辦')
const del = panel(alice, 'todos').locator('.row__drop').first()
await del.click()
ok((await del.innerText()).includes('確認'), 'the first press asks for confirmation')
ok((await rowCount(alice, 'todos')) === 2, 'and nothing is deleted yet')

await del.click()
await waitRows(bob, 'todos', 1)
ok(true, 'confirming removes it, for both participants')

await browser.close()
done('UI-AGENDA')
