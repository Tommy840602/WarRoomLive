// Recovery from a signaling outage, seen from the browser. DESTRUCTIVE:
// restarts the backend mid-session. The interesting property is that the room
// comes back *correctly* — no ghosts, no duplicates, state intact — not merely
// that the socket reopens.
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RUN_ID, chatText, done, joinRoom, launch, memberNames, ok, sendChat, sleep } from './lib.mjs'

const room = 'ui-reconnect-' + RUN_ID
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const browser = await launch()

const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(4000)
ok((await memberNames(alice)).length === 2, 'both participants are in the room to begin with')

// Mute Alice: a flag that lives only in the other clients' memory, so it has
// to be re-announced after the outage or Bob's view goes stale.
await alice.click('button:has-text("靜音")')
await sleep(1000)

console.log('   restarting the backend…')
execSync(`docker compose -f ${REPO_ROOT}docker-compose.yml restart backend`, { stdio: 'ignore' })

await alice.waitForSelector('.app__reconnecting', { timeout: 20000 })
ok(true, 'the client says it is reconnecting while the socket is down')

await alice.waitForSelector('.app__reconnecting', { state: 'detached', timeout: 90000 })
ok(true, 'the banner clears once the socket is back')
await sleep(6000)

const [aliceMembers, bobMembers] = [await memberNames(alice), await memberNames(bob)]
ok(aliceMembers.length === 2 && bobMembers.length === 2,
  `both sides list exactly two members again (${aliceMembers} / ${bobMembers})`)

const marker = 'after-reconnect-' + RUN_ID
await sendChat(alice, marker)
await sleep(3000)
ok((await chatText(bob)).includes(marker), 'chat flows again after the outage')

const back = marker + '-reply'
await sendChat(bob, back)
await sleep(3000)
ok((await chatText(alice)).includes(back), 'and in the other direction')

ok(await bob.locator('.members__status [aria-label="靜音"]').count() >= 1,
  'the mute flag was replayed, so the other side is not left with a stale view')

await browser.close()
done('UI-RECONNECT')
