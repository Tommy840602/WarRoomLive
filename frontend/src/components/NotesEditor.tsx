import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { colorFor } from '../collab/session'

/**
 * Shared meeting notes: a TipTap editor whose document is a Yjs CRDT synced
 * through the collab service. Content merges conflict-free across participants;
 * cursors and names ride the ephemeral awareness channel.
 */
export function NotesEditor({
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
