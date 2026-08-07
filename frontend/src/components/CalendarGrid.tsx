import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { AgendaItem, Triage } from '../agenda/item'
import { triageOf } from '../agenda/item'
import {
  GUTTER_PX,
  addDays,
  columnsFor,
  daysOnScreen,
  fractionOfDay,
  layOutDay,
  openingHour,
  sameDay,
  startOfDay,
} from '../agenda/grid'

interface CalendarGridProps {
  items: AgendaItem[]
  onTriage: (item: AgendaItem, next: Triage | 'auto') => void
  onDelete: (item: AgendaItem) => void
  confirming: string | null
}

/** Tall enough that a half-hour block is still a target, short enough that a day fits a screen. */
const HOUR_PX = 44
/** Ticks every three hours: hourly labels turn the gutter into a wall of numbers. */
const LABEL_EVERY = 3
/** Below this a block cannot hold a time above a title, so they go side by side. */
const TWO_LINE_PX = 32

/**
 * The agenda as a time grid.
 *
 * A list grouped by day answers "what is on Thursday". It cannot answer "is
 * Thursday afternoon free", because free time has no rows — and in a room
 * trying to find a slot, the gap between the blocks is the thing being looked
 * for. So this is a grid: a column per day, hours down the side, an item drawn
 * at its own height, and things happening at once drawn side by side.
 *
 * How many days fit is measured, not assumed. At the sidebar's default width
 * that is two or three; drag the workspace divider and it becomes a week. Seven
 * 40px stripes would be a week view in name only.
 */
export function CalendarGrid({ items, onTriage, onDelete, confirming }: CalendarGridProps) {
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()))
  const [width, setWidth] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const frameRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // The number of columns follows the panel, not the viewport: this panel is
  // resizable, so a media query would be measuring the wrong thing.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    setWidth(frame.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  // The now-line has to move or it is a lie. A minute is finer than anyone
  // reads a calendar at, and coarse enough to cost nothing.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const columns = columnsFor(width || 320)
  const days = useMemo(() => daysOnScreen(anchor, columns), [anchor, columns])

  // Opening at midnight means scrolling past eight empty hours to find today.
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = openingHour(new Date()) * HOUR_PX
  }, [])

  const today = days.some((day) => sameDay(day, now))
  const shift = (by: number) => setAnchor((from) => addDays(from, by * columns))

  return (
    <div
      className="grid"
      ref={frameRef}
      style={
        {
          '--grid-days': columns,
          '--grid-gutter': `${GUTTER_PX}px`,
        } as CSSProperties
      }
    >
      <header className="grid__bar">
        <button className="grid__step" aria-label="上一段" onClick={() => shift(-1)}>
          ‹
        </button>
        <button
          className="grid__today"
          onClick={() => setAnchor(startOfDay(new Date()))}
          disabled={today}
        >
          今天
        </button>
        <button className="grid__step" aria-label="下一段" onClick={() => shift(1)}>
          ›
        </button>
        <span className="grid__range">{rangeLabel(days)}</span>
      </header>

      <div className="grid__head">
        <span className="grid__corner" />
        {days.map((day) => (
          <span
            key={day.toISOString()}
            className={`grid__day${sameDay(day, now) ? ' grid__day--today' : ''}`}
          >
            <span className="grid__weekday">
              {day.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
            <span className="grid__date tabular">{day.getDate()}</span>
          </span>
        ))}
      </div>

      <div className="grid__scroll" ref={scrollRef}>
        <div className="grid__body" style={{ height: `${24 * HOUR_PX}px` }}>
          <div className="grid__gutter">
            {Array.from({ length: 24 }, (_, hour) => (
              <span
                key={hour}
                className="grid__hour tabular"
                style={{ top: `${hour * HOUR_PX}px` }}
              >
                {hour % LABEL_EVERY === 0 && hour !== 0 ? `${String(hour).padStart(2, '0')}:00` : ''}
              </span>
            ))}
          </div>

          {days.map((day) => (
            <div
              key={day.toISOString()}
              className={`grid__column${sameDay(day, now) ? ' grid__column--today' : ''}`}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <span
                  key={hour}
                  className={`grid__rule${hour % LABEL_EVERY === 0 ? ' grid__rule--major' : ''}`}
                  style={{ top: `${hour * HOUR_PX}px` }}
                />
              ))}

              {sameDay(day, now) && (
                <span
                  className="grid__now"
                  style={{ top: `${fractionOfDay(now) * 24 * HOUR_PX}px` }}
                  aria-hidden="true"
                />
              )}

              {layOutDay(items, day).map((block) => {
                const triage = triageOf(block.item, now)
                const px = block.height * 24 * HOUR_PX
                return (
                  <button
                    key={block.item.key}
                    className={
                      `slot slot--${triage}` +
                      (block.item.done ? ' slot--done' : '') +
                      // Two stacked lines need more room than a short block has.
                      (px < TWO_LINE_PX ? ' slot--tight' : '')
                    }
                    style={{
                      top: `${block.top * 24 * HOUR_PX}px`,
                      height: `${px}px`,
                      left: `${(block.lane / block.lanes) * 100}%`,
                      width: `${(1 / block.lanes) * 100}%`,
                    }}
                    title={describe(block.item, block.continues)}
                    onClick={() => onTriage(block.item, nextOf(triage))}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      onDelete(block.item)
                    }}
                  >
                    <span className="slot__time tabular">
                      {block.continues ? '↳ ' : ''}
                      {clock(block.item.at as string)}
                    </span>
                    <span className="slot__text">{block.item.text}</span>
                    {confirming === block.item.key && <span className="slot__confirm">再按一次刪除</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const NEXT: Record<Triage, Triage> = { now: 'later', later: 'done', done: 'now' }
const nextOf = (triage: Triage) => NEXT[triage]

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

function describe(item: AgendaItem, continues: boolean): string {
  const when = new Date(item.at as string).toLocaleString()
  const parts = [item.text, when]
  if (continues) parts.push('(從前一天延續)')
  if (item.assignee) parts.push(`@${item.assignee}`)
  return parts.join(' · ')
}

/** The span on screen, named the shortest way that is still unambiguous. */
export function rangeLabel(days: Date[]): string {
  if (days.length === 0) return ''
  const first = days[0]
  const last = days[days.length - 1]
  const month = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  if (days.length === 1) {
    return first.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  }
  // Naming one month twice tells the reader nothing they cannot see.
  return month(first) === month(last) ? month(first) : `${month(first)} – ${month(last)}`
}
