// Subtitles and the transcript panel, in a real browser.
//
// What is NOT tested here, deliberately: speech recognition itself. Chromium's
// fake capture device emits a tone rather than speech, and the Web Speech API
// talks to a Google service this sandbox cannot reach — so a suite that tried
// would be asserting on the network, not on this app. The e2e suite covers the
// plane underneath, and what is left to check is the part with a UI in it: that
// a caption arriving over the socket is drawn over the video, that the
// translation lands on the line it belongs to, and that the transcript panel and
// its summary work.
//
// So one participant is a browser and the other is a socket, saying things.
import { ORIGIN, RUN_ID, done, joinRoom, launch, ok, openPanel, sleep } from './lib.mjs'

const room = 'ui-cap-' + RUN_ID
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws')

/** A participant that is only a signaling socket — it has things to say, not a face. */
function speaker(id, name) {
  const ws = new WebSocket(`${WS_ORIGIN}/ws/signal`)
  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`${id}: socket failed`))
  })
  return {
    async join() {
      await open
      ws.send(JSON.stringify({ type: 'join', room, from: id, payload: name }))
    },
    say(text, lang, final = true) {
      ws.send(JSON.stringify({
        type: 'caption',
        room,
        from: id,
        payload: { text, lang, final, spokenAt: Date.now() },
      }))
    },
    close: () => ws.close(),
  }
}

const config = await fetch(`${ORIGIN}/api/captions/config`).then((r) => r.json())

const browser = await launch()
const alice = await joinRoom(browser, { room, name: 'Alice' })

const bob = speaker('bob-' + RUN_ID, 'Bob')
await bob.join()
await sleep(1500)

// --- The control is offered, and says what it does.
const toggle = alice.locator('button:has-text("開啟字幕")')
ok(await toggle.count() === 1, 'the room offers a caption toggle')
ok(
  await alice.locator('.caption-control select').count() === 1,
  'with a language to pick',
)

// --- A caption arriving over the socket is drawn over the video.
bob.say('這個功能下週上線', 'cmn-Hant-TW')
await alice.waitForSelector('.captions .caption', { timeout: 8000 })
ok(true, 'a caption from another participant appears over the video')
const first = alice.locator('.captions .caption').first()
ok(
  (await first.locator('.caption__text').first().innerText()).includes('這個功能下週上線'),
  'showing what was said',
)
ok(
  (await first.locator('.caption__speaker').innerText()).includes('Bob'),
  'and who said it',
)

// The overlay must not eat clicks meant for the video underneath it.
const clickable = await alice.evaluate(() => {
  const box = document.querySelector('.captions')?.getBoundingClientRect()
  if (!box) return 'no overlay'
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return hit?.closest('.captions') ? 'captions' : 'through'
})
ok(clickable === 'through', `the overlay does not intercept clicks (${clickable})`)

if (config.translation) {
  await alice.waitForSelector('.captions .caption__alt', { timeout: 10000 })
  const rows = await alice.locator('.captions .caption').first().locator('span').allInnerTexts()
  ok(
    rows.some((r) => r.includes('This feature ships next week')),
    `the translation lands on the same line (${rows.join(' / ')})`,
  )

  // Both languages, always, with Chinese first — whichever one was spoken.
  // Nobody switches to see the other; the selector is only about what you say.
  const zhIndex = rows.findIndex((r) => r.includes('這個功能下週上線'))
  const enIndex = rows.findIndex((r) => r.includes('This feature ships next week'))
  ok(zhIndex < enIndex, `中文 above English on a line spoken in Chinese (${zhIndex} < ${enIndex})`)

  bob.say('Good morning', 'en-US')
  await sleep(6000)
  const enLine = alice.locator('.captions .caption').filter({ hasText: 'Good morning' }).first()
  const enRows = await enLine.locator('span').allInnerTexts()
  ok(
    enRows.some((r) => r.includes('早安')) && enRows.some((r) => r.includes('Good morning')),
    `a line spoken in English shows both too (${enRows.join(' / ')})`,
  )
  ok(
    enRows.findIndex((r) => r.includes('早安')) <
      enRows.findIndex((r) => r.includes('Good morning')),
    'and in the same order, so the pair never swaps places between lines',
  )
}

// --- An interim is replaced, not stacked.
bob.say('我來', 'cmn-Hant-TW', false)
await sleep(400)
bob.say('我來處理', 'cmn-Hant-TW', false)
await sleep(400)
bob.say('我來處理登入問題', 'cmn-Hant-TW', false)
await sleep(600)
const drafts = await alice.locator('.caption--draft').count()
ok(drafts === 1, `a sentence being revised stays one line, not three (${drafts})`)

bob.say('我來處理登入問題', 'cmn-Hant-TW', true)
await sleep(800)
ok(
  await alice.locator('.caption--draft').count() === 0,
  'and the settled line replaces the draft rather than following it',
)

// --- The transcript panel.
if (config.recording) {
  bob.say('我們決定下週上線', 'cmn-Hant-TW')
  await sleep(1200)
  await openPanel(alice, '逐字稿', '.transcript__title')
  ok(true, 'the 逐字稿 panel is offered where transcripts are kept')

  const lines = await alice.locator('.transcript__line').count()
  ok(lines >= 3, `it lists what was said (${lines} lines)`)
  ok(
    (await alice.locator('.transcript__lines').innerText()).includes('這個功能下週上線'),
    'including the first thing said',
  )

  // The filter searches the translation too — somebody reading English types English.
  if (config.translation) {
    await alice.fill('.transcript__filter input', 'ships next')
    await sleep(400)
    const filtered = await alice.locator('.transcript__line').count()
    ok(filtered === 1, `filtering matches the translation as well (${filtered})`)
    await alice.fill('.transcript__filter input', '')
    await sleep(300)
  }

  // --- The summary.
  if (config.summary) {
    await alice.click('button:has-text("產生重點摘要")')
    await alice.waitForSelector('.summary__heading', { timeout: 30000 })
    const headings = await alice.locator('.summary__heading').allInnerTexts()
    ok(headings.includes('重點'), `the summary has its 重點 section (${headings.join('/')})`)
    ok(headings.includes('待辦'), 'and its 待辦 section')

    const tasks = await alice.locator('.summary__task').count()
    ok(tasks >= 1, `it lifted at least one action item out (${tasks})`)

    // The action item goes to the room's to-do list through the capture line,
    // which is the one path that has always understood owners.
    const before = await fetch(`${ORIGIN}/api/todos/${room}`).then((r) => r.json())
    await alice.locator('.summary__add').first().click()
    await sleep(1200)
    const after = await fetch(`${ORIGIN}/api/todos/${room}`).then((r) => r.json())
    ok(
      after.length === before.length + 1,
      `adding an action item puts it on the to-do list (${before.length} → ${after.length})`,
    )
    ok(
      await alice.locator('.summary__add:has-text("已加入")').count() === 1,
      'and the button says so, so it cannot be added twice',
    )
  }
}

bob.close()
await browser.close()
done('UI-CAPTIONS')
