// The connection-quality indicator, end to end: after a couple of sampling
// windows each participant shows a signal level for the others, and a healthy
// loopback link is reported as good rather than being flagged spuriously.
// The thresholds and the degrade/restore hysteresis are unit-tested in
// frontend/src/webrtc/quality.test.ts — what needs a browser is that real
// getStats readings flow into the UI at all.
import { RUN_ID, done, joinRoom, launch, ok, sleep } from './lib.mjs'

const room = 'ui-quality-' + RUN_ID
const browser = await launch()

const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })

// Two sampling windows (2s each) plus negotiation.
await sleep(12000)

for (const [tag, page] of [['Alice', alice], ['Bob', bob]]) {
  const signals = page.locator('.members__signal')
  const count = await signals.count()
  ok(count === 1, `${tag} shows a signal indicator for the other participant (${count})`)

  const level = await signals.first().getAttribute('class')
  ok(/members__signal--(good|fair|poor)/.test(level ?? ''),
    `${tag}'s indicator carries a graded level (${level})`)
  ok(level?.includes('good'),
    `${tag} reads a healthy local link as good, not as a false alarm (${level})`)

  const label = await signals.first().getAttribute('aria-label')
  ok(!!label && !label.includes('已降低畫質'),
    `${tag} is not degrading video on a healthy link (${label})`)
}

// Nothing to show for yourself — you are not a link.
const selfRow = alice.locator('.members__item').first()
ok(await selfRow.locator('.members__signal').count() === 0,
  'no signal indicator against your own entry')

await browser.close()
done('UI-QUALITY')
