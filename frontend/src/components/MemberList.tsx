import type { QualityLevel } from '../webrtc/quality'

export interface Member {
  id: string
  name: string
  isSelf: boolean
  audioOff?: boolean
  videoOff?: boolean
  handRaised?: boolean
  /** Link quality to this participant; absent until the first measurement. */
  quality?: QualityLevel
  /** True while we are holding back the video we send them. */
  degraded?: boolean
}

const QUALITY_LABEL: Record<QualityLevel, string> = {
  good: '連線良好',
  fair: '連線普通',
  poor: '連線不佳',
}

interface MemberListProps {
  members: Member[]
  /** Peer id of the room's current host ('' while unknown). */
  hostId?: string
  /** Whether the room is locked to newcomers (shown in the title). */
  locked?: boolean
  /** True when the viewer is the host — enables the kick buttons. */
  canKick?: boolean
  onKick?: (peerId: string) => void
}

/** Sidebar list of everyone currently in the room, self first. */
export function MemberList({ members, hostId, locked, canKick, onKick }: MemberListProps) {
  return (
    <aside className="members">
      <h2 className="members__title">
        成員 ({members.length}){locked && <span aria-label="房間已鎖定"> 🔒</span>}
      </h2>
      <ul className="members__list">
        {members.map((m) => (
          <li key={m.id} className="members__item">
            <span className="members__dot" aria-hidden />
            <span className="members__avatar">{initial(m.name)}</span>
            <span className="members__name">
              {m.name}
              {m.id === hostId && (
                <span className="members__host" aria-label="主持人" title="主持人">
                  👑
                </span>
              )}
              {m.isSelf && <span className="members__you">(你)</span>}
            </span>
            <span className="members__status">
              {m.quality && (
                <span
                  className={`members__signal members__signal--${m.quality}`}
                  aria-label={QUALITY_LABEL[m.quality] + (m.degraded ? '(已降低畫質)' : '')}
                  title={QUALITY_LABEL[m.quality] + (m.degraded ? '——已自動降低送出的畫質' : '')}
                >
                  {m.degraded ? '▂' : m.quality === 'good' ? '▂▄▆' : m.quality === 'fair' ? '▂▄' : '▂'}
                </span>
              )}
              {m.handRaised && <span aria-label="舉手">✋</span>}
              {m.audioOff && <span aria-label="靜音">🔇</span>}
              {m.videoOff && <span aria-label="關閉視訊">📷</span>}
              {canKick && !m.isSelf && (
                <button
                  className="members__kick"
                  aria-label={`移出 ${m.name}`}
                  title="移出會議室"
                  onClick={() => onKick?.(m.id)}
                >
                  ✕
                </button>
              )}
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
