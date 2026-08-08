import { useState } from 'react'
import type { Meeting } from '../signaling/types'

interface MeetingsPanelProps {
  meetings: Meeting[]
  /** Fetches the meeting's record; the caller knows the room and the auth. */
  onExport: (meeting: Meeting) => Promise<void>
}

/**
 * What this room has done.
 *
 * <p>These rows have been written since the meeting domain landed and nothing
 * ever read them — the room could not answer "when did we last meet about this,
 * and for how long" about itself. Read backwards, because a history opens on
 * what just happened and nobody scrolls to a room's first meeting.
 *
 * Each row can hand back the whole record: chat, agenda, notes, files and
 * recordings as one Markdown document. Before this a war room left nothing
 * behind but five places nobody visits together.
 */
export function MeetingsPanel({ meetings, onExport }: MeetingsPanelProps) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const take = async (meeting: Meeting) => {
    setBusy(meeting.id)
    setError(null)
    try {
      await onExport(meeting)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="agenda">
      <header className="agenda__head">
        <h2 className="agenda__title">紀錄</h2>
        <span className="agenda__count tabular">{meetings.length} 場</span>
      </header>

      {error && <p className="agenda__error">{error}</p>}
      {meetings.length === 0 && (
        <p className="agenda__empty">還沒有結束的會議。這一場結束後就會出現在這裡。</p>
      )}

      <ul className="agenda__list board">
        {meetings.map((meeting) => (
          <li key={meeting.id} className="row">
            <span className="row__body">
              <span className="row__text tabular" title={new Date(meeting.startedAt).toLocaleString()}>
                {formatStart(meeting.startedAt)}
              </span>
              {meeting.live ? (
                <span className="chip chip--soon">進行中</span>
              ) : (
                <span className="chip chip--clock tabular">
                  {formatDuration(meeting.durationSeconds ?? 0)}
                </span>
              )}
              <span className="chip chip--who">{meeting.participantPeak} 人</span>
            </span>
            <button
              className="row__take"
              disabled={busy === meeting.id}
              onClick={() => void take(meeting)}
              title="把聊天、議程、筆記、檔案與錄影匯出成一份 Markdown"
            >
              {busy === meeting.id ? '…' : '匯出'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Date and time, because a history spans days and "14:32" alone places nothing. */
export function formatStart(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

/**
 * How long it ran, in the units people say it in.
 *
 * Seconds only below a minute: "0 分" for a meeting somebody joined and left
 * reads as a bug, and it is a real thing that happens.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小時` : `${hours} 小時 ${rest} 分`
}
