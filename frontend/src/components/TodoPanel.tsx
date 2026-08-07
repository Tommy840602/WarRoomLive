import { useMemo, useState } from 'react'
import type { Todo } from '../signaling/types'
import { parseCapture, relativeTime, urgencyOf } from '../agenda/capture'

interface TodoPanelProps {
  todos: Todo[]
  /** Takes what the line parsed into; the server still validates all of it. */
  onAdd: (text: string, assignee: string, dueAt: string) => Promise<void>
  onToggle: (id: number, done: boolean) => Promise<void>
  onDelete: (id: number) => Promise<void>
}

/**
 * The room's shared list.
 *
 * Captured as one line rather than a form, because this is filled in while
 * someone is still talking — `寄簡報 @bob 明天15:00` is how the sentence was
 * said, and tabbing through four fields is not something anyone does mid-call.
 * What the line understood is shown back before it is sent, so the parse is
 * never a guess the user finds out about later.
 *
 * Ordering is the server's (open first, soonest-due, undated last) and is not
 * re-sorted here: two clients sorting differently is how two people end up
 * discussing different "first" items.
 */
export function TodoPanel({ todos, onAdd, onToggle, onDelete }: TodoPanelProps) {
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  // Re-parsed on every keystroke so the preview cannot disagree with what will
  // be sent — one parse, one source of truth.
  const parsed = useMemo(() => parseCapture(line), [line])

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
      await onAdd(parsed.text, parsed.assignee ?? '', parsed.dueAt ?? '')
      setLine('')
    })
    setBusy(false)
  }

  const remove = async (id: number) => {
    if (confirming !== id) {
      setConfirming(id)
      return
    }
    setConfirming(null)
    await run(() => onDelete(id))
  }

  const open = todos.filter((t) => !t.done).length

  return (
    <section className="agenda">
      <header className="agenda__head">
        <h2 className="agenda__title">待辦</h2>
        <span className="agenda__count tabular">
          {open} 未完成{todos.length > open && ` · ${todos.length - open} 已完成`}
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
          aria-label="新增待辦"
          onChange={(e) => setLine(e.target.value)}
        />
        <button className="capture__go" type="submit" disabled={busy || !parsed.text}>
          加入
        </button>
      </form>

      {/* Shown only once something was lifted out of the line, so an ordinary
          item adds no chrome. */}
      {(parsed.assignee || parsed.dueAt) && (
        <p className="capture__read">
          <span className="capture__read-label">解讀為</span>
          <span className="capture__read-text">{parsed.text}</span>
          {parsed.assignee && <span className="chip chip--who">@{parsed.assignee}</span>}
          {parsed.dueAt && (
            <span className="chip chip--soon tabular" title={new Date(parsed.dueAt).toLocaleString()}>
              {relativeTime(parsed.dueAt)}
            </span>
          )}
        </p>
      )}

      {error && <p className="agenda__error">{error}</p>}
      {todos.length === 0 && <p className="agenda__empty">還沒有待辦。說了什麼要做的,就記在這裡。</p>}

      <ul className="agenda__list">
        {todos.map((todo) => {
          const urgency = urgencyOf(todo.dueAt, todo.done)
          return (
            <li key={todo.id} className={`row${todo.done ? ' row--done' : ''}`}>
              <input
                className="row__check"
                type="checkbox"
                checked={todo.done}
                aria-label={`完成 ${todo.text}`}
                onChange={(e) => void run(() => onToggle(todo.id, e.target.checked))}
              />

              {/* The time rail: every row leads with how far off it is, in the
                  same column, so the list can be read down rather than across. */}
              <span
                className={`row__when tabular row__when--${urgency}`}
                title={todo.dueAt ? new Date(todo.dueAt).toLocaleString() : undefined}
              >
                {todo.dueAt ? relativeTime(todo.dueAt) : '—'}
              </span>

              <span className="row__body">
                <span className="row__text">{todo.text}</span>
                {todo.assignee && <span className="chip chip--who">@{todo.assignee}</span>}
                {todo.done && todo.completedBy && (
                  <span className="chip chip--done">✓ {todo.completedBy}</span>
                )}
              </span>

              <button
                className="row__drop"
                aria-label={`刪除 ${todo.text}`}
                title={confirming === todo.id ? '再按一次確認刪除' : '刪除'}
                onClick={() => void remove(todo.id)}
                onBlur={() => setConfirming((id) => (id === todo.id ? null : id))}
              >
                {confirming === todo.id ? '確認' : '×'}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
