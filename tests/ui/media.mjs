// The media plane, as a participant experiences it: a remote tile appears and
// actually plays the other person's microphone, while your own tile stays
// muted so you never hear yourself. Works in both mesh and SFU mode — the
// transport is chosen by the backend and the UI is identical either way.
import { RUN_ID, done, joinRoom, launch, ok, sleep, tileAudioLevels } from './lib.mjs'

const room = 'ui-media-' + RUN_ID
const browser = await launch()

const alice = await joinRoom(browser, { room, name: 'Alice' })
const bob = await joinRoom(browser, { room, name: 'Bob' })
await sleep(8000) // negotiation + a moment of media

for (const [tag, page] of [['Alice', alice], ['Bob', bob]]) {
  const tiles = await tileAudioLevels(page)
  ok(tiles.length === 2, `${tag} sees both tiles (${tiles.length})`)

  const own = tiles[0]
  ok(own.muted === true, `${tag}'s own tile is muted (no echo of your own mic)`)

  const remote = tiles[1]
  ok(remote && remote.muted === false && remote.audioTracks === 1,
    `${tag}'s remote tile carries an unmuted audio track`)
  ok(remote && remote.rms > 0.01,
    `${tag} actually hears the other participant (rms=${remote?.rms})`)
  ok(remote && remote.paused === false, `${tag}'s remote tile is playing`)
}

await browser.close()
done('UI-MEDIA')
