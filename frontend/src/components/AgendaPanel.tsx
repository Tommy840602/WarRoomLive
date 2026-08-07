import { useMemo, useState } from 'react'
import type { CalendarEvent, Todo } from '../signaling/types'
import { parseCapture, relativeTime } from '../agenda/capture'
import {
  mergeFeeds,
  sectionsOf,
  stampsOf,
  triageOf,
  isAuto,
  type AgendaItem,
  type Triage,
} from '../agenda/item'

export interface AgendaPanelProps {
  todos: Todo[]
  events: CalendarEvent[]
  /** Creates whatever the line described; the caller picks the endpoint. */
  onAdd: (captured: {
    text: string
    assignee?: string
    dueAt?: string
    endAt?: string
  }) => Promise<void>
  onTriage: (item: AgendaItem, triage: Triage | 'auto') => Promise<void>
  onDelete: (item: AgendaItem) => Promise<void>
}

const SECTIONS: { id: Exclude<Triage, never>; label: string; empty: string }[] = [
  { id: 'now', label: '現在', empty: '現在沒有要處理的。' },
  { id: 'later', label: '稍後', empty: '' },
  { id: 'done', label: '完成', empty: '' },
]

/**
 * The room's agenda, as one board.
 *
 * There is no to-do list and no calendar here — there are items, and three
 * sections that say when the room intends to deal with them. That is Chandler's
 * triage, and its point is that "現在 / 稍後" is a decision a room can actually
 * make, where "priority: P2" and "due Friday" are labels nobody agrees on.
 *
 * The clock proposes the section from the item's time and keeps proposing until
 * somebody disagrees; from then on the room's decision holds and the row says
 * so. That asymmetry is the design: automatic enough that an untouched board is
 * still right, manual enough that it never argues with the people using it.
 *
 * The calendar has not gone away — it is the other view of the same items, one
 * tap away, because "what is on Thursday" and "what are we doing now" are two
 * questions about one agenda.
 */
export function AgendaPanel({ todos, events, onAdd, onTriage, onDelete }: AgendaPanelProps) {
  const [line, setLine] = useState('')
  const [view, setView] = useState<'board' | 'calendar'>('board')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  // Re-parsed on every keystroke so the preview cannot disagree with what will
  // be sent — one parse, one source of truth.
  const parsed = useMemo(() => parseCapture(line), [line])
  const items = useMemo(() => mergeFeeds(todos, events), [todos, events])
  const sections = useMemo(() => sectionsOf(items), [items])

  const run = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const add = async () => {
    if (!parsed.text) return
    setBusy(true)
    await run(async () => {
      await onAdd(parsed)
      setLine('')
    })
    setBusy(false)
  }

  const remove = async (item: AgendaItem) => {
    if (confirming !== item.key) {
      setConfirming(item.key)
      return
    }
    setConfirming(null)
    await run(() => onDelete(item))
  }

  const open = sections.now.length + sections.later.length

  return (
    <section className="agenda">
      <header className="agenda__head">
        <h2 className="agenda__title">議程</h2>
        <div className="agenda__views" role="group" aria-label="檢視">
          <button
            className="agenda__view"
            aria-pressed={view === 'board'}
            onClick={() => setView('board')}
          >
            清單
          </button>
          <button
            className="agenda__view"
            aria-pressed={view === 'calendar'}
            onClick={() => setView('calendar')}
          >
            行事曆
          </button>
        </div>
        <span className="agenda__count tabular">
          {sections.now.length} 現在 · {open} 未完成
        </span>
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
          placeholder="要做什麼…  @負責人  明天15:00"
          aria-label="新增項目"
          onChange={(e) => setLine(e.target.value)}
        />
        <button className="capture__go" type="submit" disabled={busy || !parsed.text}>
          加入
        </button>
      </form>

      {/* Shown only once something was lifted out of the line, so an ordinary
          item adds no chrome. The stamps are named, because "this became a
          meeting" is exactly the thing a one-line capture could otherwise
          decide behind someone's back. */}
      {parsed.text && (parsed.assignee || parsed.dueAt) && (
        <p className="capture__read">
          <span className="capture__read-label">解讀為</span>
          <span className="capture__read-text">{parsed.text}</span>
          {parsed.assignee && <span className="chip chip--who">@{parsed.assignee}</span>}
          {parsed.dueAt && (
            <span className="chip chip--soon tabular" title={new Date(parsed.dueAt).toLocaleString()}>
              {relativeTime(parsed.dueAt)}
            </span>
          )}
          <span className="chip chip--stamp">{parsed.endAt ? '約會' : '待辦'}</span>
        </p>
      )}

      {error && <p className="agenda__error">{error}</p>}

      {view === 'board' ? (
        <div className="board">
          {items.length === 0 && (
            <p className="agenda__empty">還沒有任何項目。說了什麼要做的,就記在這裡。</p>
          )}
          {items.length > 0 &&
            SECTIONS.map(({ id, label, empty }) => {
              const ofSection = sections[id]
              if (ofSection.length === 0 && !empty) return null
              return (
                <section key={id} className={`band band--${id}`}>
                  <h3 className="band__label">
                    {label}
                    <span className="band__count tabular">{ofSection.length}</span>
                  </h3>
                  {ofSection.length === 0 && <p className="band__empty">{empty}</p>}
                  {ofSection.map((item) => (
                    <Row
                      key={item.key}
                      item={item}
                      confirming={confirming === item.key}
                      onTriage={(next) => void run(() => onTriage(item, next))}
                      onDelete={() => void remove(item)}
                      onBlurDelete={() =>
                        setConfirming((key) => (key === item.key ? null : key))
                      }
                    />
                  ))}
                </section>
              )
            })}
        </div>
      ) : (
        <CalendarView
          items={items}
          confirming={confirming}
          onTriage={(item, next) => void run(() => onTriage(item, next))}
          onDelete={(item) => void remove(item)}
          onBlurDelete={(item) => setConfirming((key) => (key === item.key ? null : key))}
        />
      )}
    </section>
  )
}

interface RowProps {
  item: AgendaItem
  confirming: boolean
  /** False on the calendar, where the day is already the heading above. */
  withDay?: boolean
  onTriage: (next: Triage | 'auto') => void
  onDelete: () => void
  onBlurDelete: () => void
}

/**
 * One item.
 *
 * The triage control is the only affordance that carries weight, because moving
 * something between 現在 and 稍後 is the act this board exists for. Everything
 * else — the stamps, the owner, the time — is quiet, and the absolute time
 * lives in the tooltip.
 */
function Row({ item, confirming, withDay = true, onTriage, onDelete, onBlurDelete }: RowProps) {
  const triage = triageOf(item)
  const auto = isAuto(item)
  const stamps = stampsOf(item)

  return (
    <article className={`row${item.done ? ' row--done' : ''}`}>
      <TriageButton triage={triage} auto={auto} onTriage={onTriage} text={item.text} />

      <span className="row__body">
        <span className="row__text">{item.text}</span>
        {stamps.includes('event') && (
          <span className="chip chip--stamp" title="佔用時間的約會">
            約會
          </span>
        )}
        {item.assignee && <span className="chip chip--who">@{item.assignee}</span>}
        {item.at && (
          <span
            className="chip chip--clock tabular"
            title={new Date(item.at).toLocaleString()}
          >
            {formatWhen(item, withDay)}
          </span>
        )}
        {item.done && item.completedBy && (
          <span className="chip chip--done">✓ {item.completedBy}</span>
        )}
        {item.note && <span className="row__note">{item.note}</span>}
      </span>

      <button
        className="row__drop"
        aria-label={`刪除 ${item.text}`}
        title={confirming ? '再按一次確認刪除' : '刪除'}
        onClick={onDelete}
        onBlur={onBlurDelete}
      >
        {confirming ? '確認' : '×'}
      </button>
    </article>
  )
}

const NEXT: Record<Triage, Triage> = { now: 'later', later: 'done', done: 'now' }
const MARK: Record<Triage, string> = { now: '●', later: '○', done: '✓' }
const NAME: Record<Triage, string> = { now: '現在', later: '稍後', done: '完成' }

/**
 * Triage, as one control that cycles 現在 → 稍後 → 完成 → 現在.
 *
 * A cycle rather than three buttons or a menu: there are only three states, the
 * order is the one people move through, and a row in a 320px rail has no space
 * for a control that is mostly whitespace. Right-clicking hands the item back
 * to the clock, which is the rare act and so is the hidden one.
 */
function TriageButton({
  triage,
  auto,
  onTriage,
  text,
}: {
  triage: Triage
  auto: boolean
  onTriage: (next: Triage | 'auto') => void
  text: string
}) {
  return (
    <button
      className={`triage triage--${triage}${auto ? ' triage--auto' : ''}`}
      aria-label={`${text}:${NAME[triage]}${auto ? '(自動)' : ''},按下改為${NAME[NEXT[triage]]}`}
      title={auto ? '跟著時間自動判定,按下由你決定' : '右鍵交還給時間'}
      onClick={() => onTriage(NEXT[triage])}
      onContextMenu={(e) => {
        e.preventDefault()
        onTriage('auto')
      }}
    >
      {MARK[triage]}
    </button>
  )
}

interface CalendarViewProps {
  items: AgendaItem[]
  confirming: string | null
  onTriage: (item: AgendaItem, next: Triage | 'auto') => void
  onDelete: (item: AgendaItem) => void
  onBlurDelete: (item: AgendaItem) => void
}

/**
 * The same items, read by day.
 *
 * Only items with a time appear — a calendar of undated things is a list with
 * extra steps — and the panel says how many are hidden rather than pretending
 * the agenda is smaller than it is.
 */
function CalendarView({ items, confirming, onTriage, onDelete, onBlurDelete }: CalendarViewProps) {
  const timed = items.filter((item) => item.at)
  const undated = items.length - timed.length

  if (timed.length === 0) {
    return <p className="agenda__empty">沒有排定時間的項目。</p>
  }

  return (
    <div className="board">
      {groupByDay(timed).map(([day, ofDay]) => (
        <section key={day} className="band">
          <h3 className="band__label">
            {day}
            <span className="band__count tabular">{ofDay.length}</span>
          </h3>
          {ofDay.map((item) => (
            <Row
              key={item.key}
              item={item}
              confirming={confirming === item.key}
              withDay={false}
              onTriage={(next) => onTriage(item, next)}
              onDelete={() => onDelete(item)}
              onBlurDelete={() => onBlurDelete(item)}
            />
          ))}
        </section>
      ))}
      {undated > 0 && (
        <p className="agenda__empty">另有 {undated} 個沒有時間的項目,在清單檢視。</p>
      )}
    </div>
  )
}

/** Groups by local day. The list is already in time order, so this preserves it. */
export function groupByDay(items: AgendaItem[]): [string, AgendaItem[]][] {
  const byDay = new Map<string, AgendaItem[]>()
  for (const item of items) {
    const day = formatDay(item.at as string)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(item)
    else byDay.set(day, [item])
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
  if (days === -1) return '昨天'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', weekday: 'short' })
}

function startOfDay(date: Date): Date {
  const out = new Date(date)
  out.setHours(0, 0, 0, 0)
  return out
}

/**
 * The time on a row.
 *
 * An appointment shows its clock time, because that is what you turn up at. A
 * task shows how far off it is, because nobody turns up to a deadline — they
 * want to know whether it is today's problem.
 *
 * `withDay` is the difference between the two views. On the calendar the day is
 * the heading above the row, so repeating it would be noise; on the board there
 * is no heading, and a bare "16:37" is a genuinely unanswerable question.
 */
export function formatWhen(
  item: Pick<AgendaItem, 'at' | 'endsAt' | 'kind'>,
  withDay = false,
  now: Date = new Date(),
): string {
  if (!item.at) return ''
  const start = new Date(item.at)
  if (Number.isNaN(start.getTime())) return item.at
  if (item.kind === 'event' || item.endsAt) {
    // 24-hour: a war room reads instruments, and "05:31 PM–06:31 PM" is twice
    // the width of "17:31–18:31" for the same fact.
    const time = (iso: string) =>
      new Date(iso).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
    const clock = item.endsAt ? `${time(item.at)}–${time(item.endsAt)}` : time(item.at)
    if (!withDay) return clock
    const day = formatDay(item.at, now)
    return day === '今天' ? clock : `${day} ${clock}`
  }
  return relativeTime(item.at)
}
