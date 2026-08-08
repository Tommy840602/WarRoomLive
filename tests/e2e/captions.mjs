// Live captions, the transcript they leave behind, and the meeting summary.
//
// Needs the ai overlay for the translation and summary halves:
//
//   docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
//   tests/e2e/run.sh captions
//
// Without it the first half still passes and the rest is skipped — that is the
// deployment the default profile describes, and it should be exercised too.
//
// Speech recognition is a browser API, so what is driven here is the plane
// underneath it: `caption` messages on the signaling socket, exactly as the
// browser sends them. The browser suite covers the part with a microphone in it.
import { ORIGIN, RUN_ID, done, ok, signalClient, sleep } from './lib.mjs'

const ROOM = 'cap-' + RUN_ID
const json = (res) => res.json()

const config = await fetch(`${ORIGIN}/api/captions/config`).then(json)
ok(config.recording === true, 'the deployment reports that it keeps transcripts')
ok(
  Array.isArray(config.languages) && config.languages.length === 2,
  'and names the two languages it subtitles between',
)
const zh = config.languages.find((l) => l.track === 'zh')
ok(
  zh?.recognition === 'cmn-Hant-TW',
  'the Chinese track asks for the locale Chrome actually reports (cmn-Hant-TW)',
)

const alice = signalClient('alice', 'Alice')
const bob = signalClient('bob', 'Bob')
await alice.join(ROOM)
await bob.join(ROOM)
await alice.next('peer-joined')

const caption = (client, text, lang, isFinal) =>
  client.send({
    type: 'caption',
    room: ROOM,
    from: client.id,
    payload: { text, lang, final: isFinal, spokenAt: Date.now() },
  })

// --- An interim reaches the room and is not written down.
caption(alice, '你好世', 'cmn-Hant-TW', false)
const draft = await bob.next('caption')
ok(draft.payload.text === '你好世', "an interim caption reaches the other participant")
ok(draft.payload.final === false, 'and says it is not settled yet')
ok(draft.payload.id === undefined, 'an interim carries no id, because nothing was stored')

// --- A final is recorded, stamped with an id, and echoed to the speaker.
caption(alice, '你好', 'cmn-Hant-TW', true)
const settled = await bob.until('caption', (m) => m.payload.final === true)
ok(typeof settled.payload.id === 'number', 'a final caption comes back with an id')
ok(settled.payload.speaker === 'Alice', "and with the server's word on who said it")

const echo = await alice.until('caption', (m) => m.payload.final === true)
ok(
  echo.payload.id === settled.payload.id,
  'the speaker is echoed the same id, so their own translation can find the line',
)

// --- Two speakers, two languages.
caption(bob, 'Good morning', 'en-US', true)
await alice.until('caption', (m) => m.payload.text === 'Good morning')
ok(true, "the other participant's caption comes back too")

// --- The transcript kept it.
await sleep(1000)
const lines = await fetch(`${ORIGIN}/api/captions/${ROOM}`).then(json)
ok(lines.length === 2, `only the two final lines were kept, not the draft (${lines.length})`)
ok(lines[0].text === '你好' && lines[0].speaker === 'Alice', 'in the order they were spoken')
ok(lines[1].text === 'Good morning', 'with the second speaker after the first')
ok(
  lines.every((l) => l.text !== '你好世'),
  'the interim guess never reached durable storage',
)

// --- Translation, if this deployment has a model.
if (config.translation) {
  // It arrives as its own message after the line, so it needs a moment.
  const translated = await bob
    .until('caption-translated', (m) => m.payload.id === settled.payload.id, 8000)
    .catch(() => null)
  ok(translated !== null, 'the translation follows as its own message, keyed by the line id')
  ok(
    translated?.payload.translation === 'Hello',
    `translated 你好 → ${translated?.payload.translation}`,
  )
  ok(translated?.payload.translationLang === 'en', 'and says which language it is in')

  await sleep(500)
  const after = await fetch(`${ORIGIN}/api/captions/${ROOM}`).then(json)
  const stored = after.find((l) => l.id === settled.payload.id)
  ok(stored?.translation === 'Hello', 'and the transcript kept the translation too')

  const english = after.find((l) => l.text === 'Good morning')
  ok(english?.translation === '早安', 'the other direction is translated as well (en → zh)')
} else {
  console.log('   (no model configured — translation not exercised)')
}

// --- The summary.
if (config.summary) {
  // Enough said for a summary to be worth making.
  caption(alice, '我們決定這個功能下週上線', 'cmn-Hant-TW', true)
  await bob.until('caption', (m) => m.payload.text.includes('下週上線'))
  caption(bob, '我來處理登入問題', 'cmn-Hant-TW', true)
  await alice.until('caption', (m) => m.payload.text.includes('登入'))
  await sleep(1000)

  const meetings = await fetch(`${ORIGIN}/api/meetings/${ROOM}`).then(json)
  ok(meetings.length >= 1, 'the room has a meeting to summarise')
  const meetingId = meetings[0].id

  const res = await fetch(`${ORIGIN}/api/meetings/${ROOM}/${meetingId}/summary`, {
    method: 'POST',
  })
  ok(res.ok, `the summary is produced (HTTP ${res.status})`)
  const summary = await res.json()
  ok(summary.summaryMd.includes('## 重點'), 'it has the 重點 section it promised')
  ok(summary.summaryMd.includes('## 決議'), 'and 決議')
  ok(summary.summaryMd.includes('## 待辦'), 'and 待辦')
  ok(summary.lineCount >= 3, `drawn from the transcript (${summary.lineCount} lines)`)
  ok(summary.model.length > 0, 'attributed to the model that wrote it')

  // Asking again returns what was made, rather than buying a second one.
  const again = await fetch(`${ORIGIN}/api/meetings/${ROOM}/${meetingId}/summary`, {
    method: 'POST',
  }).then(json)
  ok(
    again.generatedAt === summary.generatedAt,
    'asking twice returns the same summary, not a second model call',
  )

  const fetched = await fetch(`${ORIGIN}/api/meetings/${ROOM}/${meetingId}/summary`).then(json)
  ok(fetched.summaryMd === summary.summaryMd, 'and it can be read back')

  // A room with almost nothing said in it should not get a confident summary.
  const quiet = 'cap-quiet-' + RUN_ID
  const lonely = signalClient('solo', 'Solo')
  await lonely.join(quiet)
  await sleep(500)
  const quietMeetings = await fetch(`${ORIGIN}/api/meetings/${quiet}`).then(json)
  const quietRes = await fetch(
    `${ORIGIN}/api/meetings/${quiet}/${quietMeetings[0].id}/summary`,
    { method: 'POST' },
  )
  ok(
    quietRes.status === 422,
    `a meeting with nothing said in it is refused, not faked (HTTP ${quietRes.status})`,
  )
  lonely.close()

  // The record carries both.
  const exported = await fetch(
    `${ORIGIN}/api/meetings/${ROOM}/${meetingId}/export`,
  ).then((r) => r.text())
  ok(exported.includes('## 重點摘要'), 'the meeting export leads with the summary')
  ok(exported.includes('## 逐字稿'), 'and carries the transcript')
  ok(exported.includes('你好'), 'including what was actually said')
} else {
  console.log('   (no model configured — summary not exercised)')
}

alice.close()
bob.close()
done('CAPTIONS')
