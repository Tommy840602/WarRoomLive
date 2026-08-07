// Shared harness for the browser suites. These drive the real app in a real
// browser — the only place where "is there actually sound coming out" and
// "does the panel really re-render" can be answered. Fake camera/mic devices
// give deterministic media (Chromium emits a tone and a moving pattern).
import { chromium } from 'playwright'

export const ORIGIN = process.env.UI_ORIGIN ?? 'http://localhost:8088'
export const RUN_ID = process.argv[2] ?? String(Date.now())

const LAUNCH_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--no-sandbox',
]

let passed = 0
const failures = []

export function ok(cond, label) {
  if (cond) {
    console.log('ok: ' + label)
    passed++
  } else {
    console.error('FAIL: ' + label)
    failures.push(label)
  }
}

export function done(suite) {
  if (failures.length) {
    console.error(`\n${suite}: ${failures.length} FAILED — ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(`\nALL ${passed} ${suite} CHECKS PASSED`)
  process.exit(0)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Launches a browser; each participant gets its own context (its own devices). */
export async function launch() {
  return chromium.launch({
    args: LAUNCH_ARGS,
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  })
}

/**
 * Opens a page, joins `room` as `name`, and returns once the app reports it is
 * in the room. Page errors are surfaced — a suite that fails because the app
 * threw should say so rather than time out mysteriously.
 */
export async function joinRoom(browser, { room, name, tag = name }) {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`[${tag}] page error: ${String(e).slice(0, 200)}`))
  await page.goto(ORIGIN)
  await page.fill('input[placeholder="輸入顯示名稱"]', name)
  await page.locator('section.app__controls input').nth(1).fill(room)
  await page.click('button:has-text("加入房間")')
  await page.waitForSelector('button:has-text("離開房間")', { timeout: 20000 })
  page.tag = tag
  return page
}

/** Display names shown in the member list, sorted for stable comparison. */
export const memberNames = (page) =>
  page.locator('.members__name').allInnerTexts().then((n) => n.sort())

export async function sendChat(page, text) {
  const box = page.locator('.chat input, .chat textarea').first()
  await box.fill(text)
  await box.press('Enter')
}

export const chatText = (page) => page.locator('.chat').innerText()

/**
 * Peak RMS of what a tile's <video> element is actually playing, via
 * captureStream. Note: createMediaElementSource returns silence for srcObject
 * MediaStreams in Chrome whether or not the element is playing, so it cannot
 * be used to answer this question.
 */
export function tileAudioLevels(page) {
  return page.evaluate(async () => {
    const out = []
    for (const [i, v] of [...document.querySelectorAll('.video-tile video')].entries()) {
      const info = { index: i, muted: v.muted, paused: v.paused }
      const tracks = v.captureStream().getAudioTracks()
      info.audioTracks = tracks.length
      if (!v.muted && tracks.length) {
        const ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        ctx.createMediaStreamSource(new MediaStream(tracks)).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        let peak = 0
        const started = Date.now()
        while (Date.now() - started < 2000) {
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (const x of buf) sum += x * x
          peak = Math.max(peak, Math.sqrt(sum / buf.length))
          await new Promise((r) => setTimeout(r, 50))
        }
        await ctx.close()
        info.rms = Number(peak.toFixed(5))
      }
      out.push(info)
    }
    return out
  })
}

/** Non-transparent pixel count of the first canvas — proof the board rendered. */
export const canvasInk = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return 0
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++
    return n
  })
