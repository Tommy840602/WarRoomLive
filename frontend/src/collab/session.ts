import { useEffect, useState } from 'react'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import * as Y from 'yjs'

/** Resolves the collab-doc URL from the current page origin (works behind the Vite/nginx proxies). */
export function defaultDocUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws/doc`
}

/** Stable per-user cursor color, derived from the display name. */
const CURSOR_COLORS = ['#f783ac', '#74b816', '#1c7ed6', '#f59f00', '#be4bdb', '#0ca678', '#e8590c', '#7048e8']
export function colorFor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]
}

/**
 * Caps awareness broadcasts (cursor moves, selections, in-progress strokes) to
 * ~25 Hz with a trailing-edge flush, per the blueprint's 20–30 Hz guidance.
 */
function throttleAwareness(provider: HocuspocusProvider, intervalMs = 40): () => void {
  const awareness = provider.awareness
  if (!awareness) return () => {}
  const original = awareness.setLocalStateField.bind(awareness)
  const queued = new Map<string, unknown>()
  let lastFlush = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    lastFlush = Date.now()
    queued.forEach((value, field) => original(field, value))
    queued.clear()
  }
  awareness.setLocalStateField = (field: string, value: unknown) => {
    queued.set(field, value)
    const elapsed = Date.now() - lastFlush
    if (elapsed >= intervalMs) flush()
    else if (!timer) timer = setTimeout(flush, intervalMs - elapsed)
  }
  return () => {
    if (timer) clearTimeout(timer)
    awareness.setLocalStateField = original
  }
}

export interface CollabSession {
  doc: Y.Doc
  provider: HocuspocusProvider
}

/**
 * One Yjs session per room shared by every collaborative surface (notes,
 * whiteboard): a single document, a single connection through /ws/doc, one
 * awareness channel. Provider lifecycle lives in an effect so StrictMode
 * double-mounts tear down cleanly.
 */
export function useCollabSession(room: string, token?: string | null) {
  const [session, setSession] = useState<CollabSession | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url: defaultDocUrl(),
      name: `warroom:${room}`,
      document: doc,
      token: token ?? undefined,
      onStatus: ({ status }) => setConnected(status === WebSocketStatus.Connected),
    })
    const restoreAwareness = throttleAwareness(provider)
    setSession({ doc, provider })
    return () => {
      restoreAwareness()
      provider.destroy()
      doc.destroy()
      setSession(null)
      setConnected(false)
    }
  }, [room, token])

  return { session, connected }
}
