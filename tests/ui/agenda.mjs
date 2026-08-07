// The shared to-do list and calendar as two participants use them together.
// Needs a database, which the base stack has.
//
// What only a browser answers: does a change one person makes reach the other
// *without a reload* (it travels over signaling, not polling), and does the
// list they both see agree — including the ordering, which the server owns.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-agenda-' + RUN_ID

const browser = await launch()
const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(2000)

ok(await alice.locator('.todos').count() === 1, 'the room offers a shared to-do list')
ok(await alice.locator('.calendar').count() === 1, 'and a shared calendar')

// --- Alice adds two items, the later-due one first.
const addTodo = async (page, text, dueOffsetHours) => {
  await page.fill('.todos__text', text)
  if (dueOffsetHours !== undefined) {
    const at = new Date(Date.now() + dueOffsetHours * 3600_000)
    // datetime-local wants local wall-clock with no zone.
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
      .toISOString().slice(0, 16)
    await page.fill('.todos__due', local)
  }
  await page.click('.todos__form button[type=submit]')
}

await addTodo(alice, '訂會議室', 48)
await alice.waitForSelector('.todos__item')
await addTodo(alice, '寄簡報', 2)
await alice.waitForFunction(
  () => document.querySelectorAll('.todos__item').length === 2, null, { timeout: 15000 })

const aliceOrder = await alice.locator('.todos__body').allInnerTexts()
ok(aliceOrder.join(',') === '寄簡報,訂會議室',
  `the soonest-due item is listed first (${aliceOrder.join(',')})`)

// --- Bob sees them appear without reloading: the change came over signaling.
await bob.waitForFunction(
  () => document.querySelectorAll('.todos__item').length === 2, null, { timeout: 15000 })
const bobOrder = await bob.locator('.todos__body').allInnerTexts()
ok(bobOrder.join(',') === aliceOrder.join(','),
  'the other participant sees the same list, in the same order, without reloading')

// --- Bob ticks one off; Alice sees it, and it sinks below what is still open.
await bob.locator('.todos__item input[type=checkbox]').first().click()
await alice.waitForFunction(
  () => document.querySelectorAll('.todos__item--done').length === 1,
  null, { timeout: 15000 })
ok(true, 'completing an item reaches the other participant')

const afterDone = await alice.locator('.todos__body').allInnerTexts()
ok(afterDone[afterDone.length - 1] === '寄簡報',
  `a completed item sinks below what is still open (${afterDone.join(',')})`)

// --- The calendar, same round trip.
const at = new Date(Date.now() + 3 * 3600_000)
const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
await alice.fill('.calendar__subject', '週會')
await alice.fill('input[aria-label="開始時間"]', local)
await alice.click('.calendar__form button[type=submit]')

await bob.waitForSelector('.calendar__entry', { timeout: 15000 })
const title = await bob.locator('.calendar__subject-text').first().innerText()
ok(title === '週會', `a calendar entry reaches the other participant live (${title})`)
// Grouped under a day heading, because "which day" is the first question.
ok(await bob.locator('.calendar__day-label').count() >= 1,
  'and is grouped under the day it falls on')

// --- Deleting takes two presses, like everything else destructive here.
const del = alice.locator('.todos__delete').first()
await del.click()
ok((await del.innerText()).includes('確認'), 'the first press asks for confirmation')
ok(await alice.locator('.todos__item').count() === 2, 'and nothing is deleted yet')

await del.click()
await bob.waitForFunction(
  () => document.querySelectorAll('.todos__item').length === 1, null, { timeout: 15000 })
ok(true, 'confirming removes it, for both participants')

await browser.close()
done('UI-AGENDA')
