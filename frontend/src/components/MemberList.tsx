export interface Member {
  id: string
  name: string
  isSelf: boolean
  audioOff?: boolean
  videoOff?: boolean
  handRaised?: boolean
}

interface MemberListProps {
  members: Member[]
}

/** Sidebar list of everyone currently in the room, self first. */
export function MemberList({ members }: MemberListProps) {
  return (
    <aside className="members">
      <h2 className="members__title">成員 ({members.length})</h2>
      <ul className="members__list">
        {members.map((m) => (
          <li key={m.id} className="members__item">
            <span className="members__dot" aria-hidden />
            <span className="members__avatar">{initial(m.name)}</span>
            <span className="members__name">
              {m.name}
              {m.isSelf && <span className="members__you">(你)</span>}
            </span>
            <span className="members__status">
              {m.handRaised && <span aria-label="舉手">✋</span>}
              {m.audioOff && <span aria-label="靜音">🔇</span>}
              {m.videoOff && <span aria-label="關閉視訊">📷</span>}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/** First visible character of a name, for the avatar badge. */
function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?'
}
