import { useState } from 'react'
import type { CalendarEvent } from '../signaling/types'
import { localInputToInstant } from './TodoPanel'

interface CalendarPanelProps {
  events: CalendarEvent[]
  onAdd: (title: string, startsAt: string, endsAt: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
}

/**
 * The room's shared calendar.
 *
 * <p>Shows what is coming, because that is what a calendar in a war room is
 * for; the server reads forwards from now unless asked otherwise. Entries are
 * grouped by day, since "which day" is the first question and a flat list of
 * timestamps makes it the hardest one.
 */
export function CalendarPanel({ events, onAdd, onDelete }: CalendarPanelProps) {
  const [title, setTitle] = useState('')
  const [starts, setStarts] = useState('')
  const [ends, setEnds] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const add = async () => {
    if (!title.trim() || !starts) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(title.trim(), localInputToInstant(starts), localInputToInstant(ends))
      setTitle('')
      setStarts('')
      setEnds('')
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
    <aside className="calendar">
      <h2 className="calendar__title">行事曆 ({events.length})</h2>

      <form
        className="calendar__form"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          className="calendar__subject"
          value={title}
          placeholder="事項"
          aria-label="行事曆事項"
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="calendar__row">
          <input
            type="datetime-local"
            value={starts}
            aria-label="開始時間"
            onChange={(e) => setStarts(e.target.value)}
          />
          <input
            type="datetime-local"
            value={ends}
            aria-label="結束時間"
            onChange={(e) => setEnds(e.target.value)}
          />
          <button type="submit" disabled={busy || !title.trim() || !starts}>
            新增
          </button>
        </div>
      </form>

      {error && <p className="calendar__error">⚠️ {error}</p>}
      {events.length === 0 && <p className="calendar__empty">接下來沒有安排</p>}

      <ul className="calendar__list">
        {groupByDay(events).map(([day, ofDay]) => (
          <li key={day} className="calendar__day">
            <h3 className="calendar__day-label">{day}</h3>
            <ul className="calendar__entries">
              {ofDay.map((event) => (
                <li key={event.id} className="calendar__entry">
                  <span className="calendar__when">{formatRange(event)}</span>
                  <span className="calendar__meta">
                    <span className="calendar__subject-text">{event.title}</span>
                    {event.description && (
                      <span className="calendar__description">{event.description}</span>
                    )}
                  </span>
                  <button
                    className="calendar__delete"
                    aria-label={`刪除 ${event.title}`}
                    title={confirming === event.id ? '再按一次確認刪除' : '刪除'}
                    onClick={() => void remove(event.id)}
                    onBlur={() => setConfirming((id) => (id === event.id ? null : id))}
                  >
                    {confirming === event.id ? '確認刪除' : '🗑'}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/**
 * Groups entries by local day, preserving the server's ordering.
 *
 * <p>A Map keeps insertion order, so the days come out in the order the server
 * sent them — re-sorting here would risk disagreeing with it.
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

export function formatDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', weekday: 'short' })
}

export function formatRange(event: Pick<CalendarEvent, 'startsAt' | 'endsAt'>): string {
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const start = new Date(event.startsAt)
  if (Number.isNaN(start.getTime())) return event.startsAt
  // An entry with no end is a moment, and showing "09:00–" reads as unfinished.
  return event.endsAt ? `${time(event.startsAt)}–${time(event.endsAt)}` : time(event.startsAt)
}
