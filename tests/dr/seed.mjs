// Seeds recognizable data through the real application paths (not raw SQL):
// a chat message over the signaling WebSocket and, optionally, a shared-notes
// edit through the collab service. Usage: node seed.mjs <marker> [--with-notes]
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const marker = process.argv[2]
const withNotes = process.argv.includes('--with-notes')
const ROOM = process.env.DR_ROOM ?? 'dr-drill'
const ORIGIN = process.env.ORIGIN ?? 'ws://localhost:8088'

const ws = new WebSocket(`${ORIGIN}/ws/signal`)
await new Promise((res, rej) => {
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: ROOM, from: 'dr-seeder', payload: 'DR' }))
  ws.onmessage = (ev) => { if (JSON.parse(ev.data).type === 'peers') res() }
  ws.onerror = () => rej(new Error('signaling connect failed'))
  setTimeout(() => rej(new Error('join timeout')), 8000)
})
ws.send(JSON.stringify({ type: 'chat', room: ROOM, from: 'dr-seeder', payload: marker }))
await new Promise((r) => setTimeout(r, 500))

if (withNotes) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: `${ORIGIN}/ws/doc`, name: `warroom:${ROOM}`, document: doc, WebSocketPolyfill: WebSocket,
  })
  await new Promise((res, rej) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (provider.isSynced) { clearInterval(iv); res() }
      else if (Date.now() - t0 > 8000) { clearInterval(iv); rej(new Error('collab sync timeout')) }
    }, 50)
  })
  doc.getText('e2e').insert(0, `notes:${marker} `)
  await new Promise((r) => setTimeout(r, 4000)) // let the debounced snapshot land
  provider.destroy()
}

ws.close()
console.log(`seeded: ${marker}${withNotes ? ' (+notes)' : ''}`)
process.exit(0)
