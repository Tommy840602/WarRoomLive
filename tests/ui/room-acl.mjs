// Room permissions as the UI presents them. The server enforces the rules —
// what matters here is that the interface only offers what the server would
// allow, and that a removed participant is actually put out of the room.
import { RUN_ID, done, joinRoom, launch, memberNames, ok, sleep } from './lib.mjs'

const room = 'ui-acl-' + RUN_ID
const browser = await launch()

const host = await joinRoom(browser, { room, name: 'Host' })
const guest = await joinRoom(browser, { room, name: 'Guest' })
await sleep(3000)

// --- Affordances differ by role.
ok(await host.locator('.members__host').count() === 1, 'the host sees exactly one crown')
ok(await guest.locator('.members__host').count() === 1, 'the guest sees the crown too (same host)')
ok(await host.locator('button:has-text("鎖定房間")').count() === 1, 'the host is offered the lock')
ok(await guest.locator('button:has-text("鎖定房間")').count() === 0,
  'the guest is not offered the lock')
ok(await host.locator('.members__kick').count() === 1,
  'the host is offered one kick button (never against itself)')
ok(await guest.locator('.members__kick').count() === 0, 'the guest is offered no kick buttons')

// --- Locking is reflected on both sides.
await host.click('button:has-text("鎖定房間")')
await host.waitForSelector('button:has-text("解除鎖定")', { timeout: 5000 })
await guest.waitForSelector('.members__title:has-text("🔒")', { timeout: 5000 })
ok(true, 'locking the room shows the padlock for everyone')

await host.click('button:has-text("解除鎖定")')
await guest.waitForSelector('.members__title:has-text("🔒")', { state: 'detached', timeout: 5000 })
ok(true, 'unlocking clears it again')

// --- A kicked participant leaves and stays gone: the reconnect loop must not
//     quietly walk them back in.
await host.click('.members__kick')
await guest.waitForSelector('.app__error:has-text("移出會議室")', { timeout: 10000 })
ok(true, 'the kicked participant is returned to the lobby with an explanation')

await sleep(20000) // well past several reconnect backoff attempts
ok(await guest.locator('button:has-text("離開房間")').count() === 0,
  'the kicked participant is not brought back by the reconnect loop')
ok(await guest.locator('.app__reconnecting').count() === 0,
  'no reconnecting banner on a kicked client')
ok((await memberNames(host)).length === 1, 'the host is alone in the room afterwards')

await browser.close()
done('UI-ROOM-ACL')
