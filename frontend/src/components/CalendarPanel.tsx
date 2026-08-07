import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../signaling/types'
import { parseCapture, relativeTime } from '../agenda/capture'

interface CalendarPanelProps {
  events: CalendarEvent[]
  onAdd: (title: string, startsAt: string, endsAt: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
}

/**
 * The room's shared calendar, read forwards.
 *
 * Same one-line capture as the list, for the same reason. Entries group under
 * a day heading because "which day" is the first question, and every row leads
 * with how far off it is, because a room reads "3 小時後" faster than it reads
 * "8/9 09:00" — the absolute time is in the tooltip, where it belongs.
 */
export function CalendarPanel({ events, onAdd, onDelete }: CalendarPanelProps) {
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const parsed = useMemo(() => parseCapture(line), [line])

  const add = async () => {
    if (!parsed.text || !parsed.dueAt) return
    setBusy(true)
    setError(null)
    try {
      // A calendar entry is a moment, so what the line parsed as a deadline is
      // its start. No end unless someone edits it — most entries have none.
      await onAdd(parsed.text, parsed.dueAt, '')
      setLine('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: number) => {
    if (confirming !== id) {
      setConfirming(id)
      return
    }
    setConfirming(null)
    setError(null)
    try {
      await onDelete(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="agenda">
      <header className="agenda__head">
        <h2 className="agenda__title">行事曆</h2>
        <span className="agenda__count tabular">接下來 {events.length}</span>
      </header>

      <form
        className="capture"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          className="capture__line"
          value={line}
          placeholder="什麼事…  週三14:00"
          aria-label="新增行事曆事項"
          onChange={(e) => setLine(e.target.value)}
        />
        <button className="capture__go" type="submit" disabled={busy || !parsed.text || !parsed.dueAt}>
          加入
        </button>
      </form>

      {/* Unlike a to-do, a calendar entry without a time cannot be placed at
          all — so say that, rather than disabling the button silently. */}
      {parsed.text && !parsed.dueAt && (
        <p className="capture__read capture__read--needs">
          <span className="capture__read-label">還需要時間</span>
          <span className="capture__read-hint">例如「明天15:00」「週三」「3天後」</span>
        </p>
      )}
      {parsed.text && parsed.dueAt && (
        <p className="capture__read">
          <span className="capture__read-label">解讀為</span>
          <span className="capture__read-text">{parsed.text}</span>
          <span className="chip chip--soon tabular" title={new Date(parsed.dueAt).toLocaleString()}>
            {relativeTime(parsed.dueAt)}
          </span>
        </p>
      )}

      {error && <p className="agenda__error">{error}</p>}
      {events.length === 0 && <p className="agenda__empty">接下來沒有安排。</p>}

      <ul className="agenda__list">
        {groupByDay(events).map(([day, ofDay]) => (
          <li key={day} className="day">
            <h3 className="day__label">{day}</h3>
            <ul className="day__entries">
              {ofDay.map((event) => (
                <li key={event.id} className="row">
                  <span
                    className="row__when tabular row__when--later"
                    title={new Date(event.startsAt).toLocaleString()}
                  >
                    {relativeTime(event.startsAt)}
                  </span>
                  <span className="row__body">
                    <span className="row__text">{event.title}</span>
                    <span className="chip chip--clock tabular">{formatRange(event)}</span>
                    {event.description && <span className="row__note">{event.description}</span>}
                  </span>
                  <button
                    className="row__drop"
                    aria-label={`刪除 ${event.title}`}
                    title={confirming === event.id ? '再按一次確認刪除' : '刪除'}
                    onClick={() => void remove(event.id)}
                    onBlur={() => setConfirming((id) => (id === event.id ? null : id))}
                  >
                    {confirming === event.id ? '確認' : '×'}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Groups entries by local day, preserving the server's ordering.
 *
 * A Map keeps insertion order, so the days come out as the server sent them —
 * re-sorting here would risk disagreeing with it.
 */
export function groupByDay(events: CalendarEvent[]): [string, CalendarEvent[]][] {
  const byDay = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const day = formatDay(event.startsAt)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(event)
    else byDay.set(day, [event])
  }
  return [...byDay]
}

/** Today and tomorrow are named, because that is what people call them. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const days = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000,
  )
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', weekday: 'short' })
}

function startOfDay(date: Date): Date {
  const out = new Date(date)
  out.setHours(0, 0, 0, 0)
  return out
}

export function formatRange(event: Pick<CalendarEvent, 'startsAt' | 'endsAt'>): string {
  // 24-hour: a war room reads instruments, and "05:31 PM–06:31 PM" is twice
  // the width of "17:31–18:31" for the same fact.
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  const start = new Date(event.startsAt)
  if (Number.isNaN(start.getTime())) return event.startsAt
  // An entry with no end is a moment; showing "09:00–" reads as unfinished.
  return event.endsAt ? `${time(event.startsAt)}–${time(event.endsAt)}` : time(event.startsAt)
}
