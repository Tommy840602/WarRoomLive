import { useState } from 'react'
import { useCollabSession } from '../collab/session'
import { BoardCanvas } from './BoardCanvas'
import { NotesEditor } from './NotesEditor'

/**
 * The room's collaborative surfaces — shared notes and the whiteboard — as tabs
 * over one Yjs session (one document, one /ws/doc connection). The notes editor
 * stays mounted when hidden so its editor state and cursor presence survive tab
 * switches; the board mounts on demand.
 */
export function CollabPanel({
  room,
  userName,
  token,
}: {
  room: string
  userName: string
  /** OIDC access token when auth is active; verified by the collab service. */
  token?: string | null
}) {
  const { session, connected } = useCollabSession(room, token)
  const [tab, setTab] = useState<'notes' | 'board'>('notes')

  return (
    <section className="notes">
      <div className="notes__header">
        <h2 className="notes__title">
          協作
          <span
            className={connected ? 'notes__dot notes__dot--on' : 'notes__dot'}
            title={connected ? '已同步' : '連線中…'}
          />
        </h2>
        <div className="notes__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'notes'}
            className={tab === 'notes' ? 'notes__tab notes__tab--active' : 'notes__tab'}
            onClick={() => setTab('notes')}
          >
            共同筆記
          </button>
          <button
            role="tab"
            aria-selected={tab === 'board'}
            className={tab === 'board' ? 'notes__tab notes__tab--active' : 'notes__tab'}
            onClick={() => setTab('board')}
          >
            白板
          </button>
        </div>
      </div>
      {session && (
        <>
          <div style={{ display: tab === 'notes' ? 'block' : 'none' }}>
            <NotesEditor doc={session.doc} provider={session.provider} userName={userName} />
          </div>
          {tab === 'board' && <BoardCanvas doc={session.doc} provider={session.provider} />}
        </>
      )}
    </section>
  )
}
