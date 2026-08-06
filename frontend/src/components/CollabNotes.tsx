import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import * as Y from 'yjs'

/** Resolves the collab-doc URL from the current page origin (works behind the Vite/nginx proxies). */
export function defaultDocUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws/doc`
}

/** Stable per-user cursor color, derived from the display name. */
const CURSOR_COLORS = ['#f783ac', '#74b816', '#1c7ed6', '#f59f00', '#be4bdb', '#0ca678', '#e8590c', '#7048e8']
function colorFor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]
}

interface CollabNotesProps {
  room: string
  userName: string
}

/**
 * Shared meeting notes: a TipTap editor whose document is a Yjs CRDT synced through
 * the collab service (Hocuspocus) at /ws/doc. Content merges conflict-free across
 * participants; cursors and names ride the ephemeral awareness channel.
 */
export function CollabNotes({ room, userName }: CollabNotesProps) {
  const [session, setSession] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null)
  const [connected, setConnected] = useState(false)

  // Provider lifecycle lives in an effect so StrictMode double-mounts tear down cleanly.
  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url: defaultDocUrl(),
      name: `warroom:${room}`,
      document: doc,
      onStatus: ({ status }) => setConnected(status === WebSocketStatus.Connected),
    })
    setSession({ doc, provider })
    return () => {
      provider.destroy()
      doc.destroy()
      setSession(null)
      setConnected(false)
    }
  }, [room])

  return (
    <section className="notes">
      <h2 className="notes__title">
        共同筆記
        <span
          className={connected ? 'notes__dot notes__dot--on' : 'notes__dot'}
          title={connected ? '已同步' : '連線中…'}
        />
      </h2>
      {session && <NotesEditor doc={session.doc} provider={session.provider} userName={userName} />}
    </section>
  )
}

function NotesEditor({
  doc,
  provider,
  userName,
}: {
  doc: Y.Doc
  provider: HocuspocusProvider
  userName: string
}) {
  const editor = useEditor(
    {
      extensions: [
        // Yjs carries its own undo history; TipTap's must be off to avoid conflicts.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: doc }),
        CollaborationCursor.configure({
          provider,
          user: { name: userName, color: colorFor(userName) },
        }),
      ],
      editorProps: {
        attributes: { class: 'notes__editor', 'aria-label': '共同筆記編輯區' },
      },
    },
    [doc, provider],
  )

  return <EditorContent editor={editor} className="notes__content" />
}
