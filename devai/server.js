// DEV-ONLY stand-in for a language model. NEVER DEPLOY THIS.
//
// It speaks the OpenAI chat-completions wire format and nothing else, so the
// backend's ai profile can be exercised — translation on the caption plane, and
// meeting summaries — with no API key, no network egress and no bill. The same
// role devidp plays for OIDC: a real protocol, a fake brain.
//
// What it does is *deterministic*, which is the point. A test that asserts
// "@bob's line came back in English" needs the same answer every run, and a real
// model gives a different sentence each time. So: a small phrasebook for the
// lines the test suites actually speak, and for anything else an honest marked
// echo — never an invented translation, because a stub that guesses would let a
// broken translator look like a working one.
//
// Production swaps this for AI_BASE_URL pointing at OpenAI, Azure, Ollama,
// vLLM or LiteLLM. Nothing in the backend changes.
import http from 'node:http'

const PORT = Number(process.env.PORT || 8090)
const MODEL = process.env.MODEL_NAME || 'devai-phrasebook'

// The phrases the e2e and browser suites say out loud, both directions.
// Deliberately small: this is a fixture, not a dictionary.
const PHRASEBOOK = new Map(Object.entries({
  '你好': 'Hello',
  '早安': 'Good morning',
  '我們下週再談': "Let's talk again next week",
  '這個功能下週上線': 'This feature ships next week',
  '我來處理登入問題': "I'll take care of the login problem",
  '會議結束': 'End of meeting',
  hello: '你好',
  'good morning': '早安',
  "let's talk again next week": '我們下週再談',
  'this feature ships next week': '這個功能下週上線',
  "i'll take care of the login problem": '我來處理登入問題',
  'end of meeting': '會議結束',
}))

/** Strips the trailing punctuation a recognizer adds, so lookups still hit. */
const key = (s) => s.trim().replace(/[.。!！?？,，]+$/u, '').toLowerCase()

function translate(text) {
  const hit = PHRASEBOOK.get(key(text)) ?? PHRASEBOOK.get(text.trim())
  // The marker matters. Without it a caller could not tell a real translation
  // from the stub passing text through, and a translator that had silently
  // stopped translating would look exactly like one that was working.
  return hit ?? `[devai] ${text.trim()}`
}

/**
 * A summary with the right shape and no intelligence behind it.
 *
 * Structure is what the backend and the UI depend on — three headings, task
 * checkboxes, @owners — so that is what this reproduces faithfully. The content
 * is drawn from the transcript by keyword, which is enough for a test to assert
 * "the decision made in the meeting reached the 決議 section" and honest about
 * being nothing more.
 */
function summarize(transcript) {
  const lines = transcript.split('\n')
    .map((l) => l.replace(/^\[\d{2}:\d{2}\]\s*/, '').trim())
    .filter(Boolean)

  const said = (l) => l.replace(/^[^:：]+[:：]\s*/, '')
  const speaker = (l) => (l.match(/^([^:：]+)[:：]/) || [, ''])[1].trim()

  const decisions = lines.filter((l) => /決定|決議|我們就|decide|agreed|we'll go with/i.test(l))
  const actions = lines.filter((l) => /我來|我會|負責|處理|i'll|i will|take care/i.test(l))
  const points = lines.slice(0, 6)

  const out = ['## 重點', '']
  for (const l of points) out.push(`- ${said(l)}`)
  out.push('', '## 決議', '')
  if (decisions.length === 0) out.push('- 這場會議沒有做出明確決議。')
  else for (const l of decisions) out.push(`- ${said(l)}`)
  out.push('', '## 待辦', '')
  if (actions.length === 0) out.push('- 沒有指派出去的待辦。')
  else for (const l of actions) out.push(`- [ ] ${said(l)} — @${speaker(l)}`)
  return out.join('\n')
}

const server = http.createServer((req, res) => {
  const json = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { status: 'ok', model: MODEL })
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    return json(404, { error: { message: 'devai serves POST /v1/chat/completions only' } })
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    // A stub with no limit is still a service somebody can point traffic at.
    if (body.length > 1_000_000) req.destroy()
  })
  req.on('end', () => {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return json(400, { error: { message: 'invalid JSON' } })
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''

    // Which job this is, read off the prompt the backend actually sends.
    const isSummary = system.includes('## 重點')
    let content
    if (isSummary) {
      content = summarize(user)
    } else {
      // The backend's translate prompt is "Translate into X:\n<line>".
      const line = user.replace(/^Translate into [^\n]*\n/, '')
      content = translate(line)
    }

    json(200, {
      id: 'devai-' + Date.now(),
      object: 'chat.completion',
      model: parsed.model || MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  })
})

server.listen(PORT, () => {
  console.log(`devai (DEV ONLY) listening on :${PORT} as model "${MODEL}"`)
})
