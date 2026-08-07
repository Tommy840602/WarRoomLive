import { useState } from 'react'
import type { Todo } from '../signaling/types'

interface TodoPanelProps {
  todos: Todo[]
  onAdd: (text: string, assignee: string, dueAt: string) => Promise<void>
  onToggle: (id: number, done: boolean) => Promise<void>
  onDelete: (id: number) => Promise<void>
}

/**
 * The room's shared to-do list.
 *
 * <p>The server orders it — open items first, then soonest-due — so this
 * renders what it is given rather than sorting again. Two clients sorting the
 * same list by different rules is how two people end up talking about different
 * "first" items.
 */
export function TodoPanel({ todos, onAdd, onToggle, onDelete }: TodoPanelProps) {
  const [text, setText] = useState('')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const run = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const add = async () => {
    if (!text.trim()) return
    setBusy(true)
    await run(async () => {
      await onAdd(text.trim(), assignee.trim(), due)
      setText('')
      setAssignee('')
      setDue('')
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
    <aside className="todos">
      <h2 className="todos__title">待辦 ({open}/{todos.length})</h2>

      <form
        className="todos__form"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          className="todos__text"
          value={text}
          placeholder="要做什麼"
          aria-label="待辦事項"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="todos__row">
          <input
            className="todos__assignee"
            value={assignee}
            placeholder="負責人(選填)"
            aria-label="負責人"
            onChange={(e) => setAssignee(e.target.value)}
          />
          <input
            className="todos__due"
            type="datetime-local"
            value={due}
            aria-label="期限"
            onChange={(e) => setDue(e.target.value)}
          />
          <button type="submit" disabled={busy || !text.trim()}>
            新增
          </button>
        </div>
      </form>

      {error && <p className="todos__error">⚠️ {error}</p>}

      <ul className="todos__list">
        {todos.map((todo) => (
          <li key={todo.id} className={`todos__item${todo.done ? ' todos__item--done' : ''}`}>
            <input
              type="checkbox"
              checked={todo.done}
              aria-label={`完成 ${todo.text}`}
              onChange={(e) => void run(() => onToggle(todo.id, e.target.checked))}
            />
            <span className="todos__meta">
              <span className="todos__body">{todo.text}</span>
              <span className="todos__detail">
                {todo.assignee && <span className="todos__who">@{todo.assignee}</span>}
                {todo.dueAt && (
                  <span className={dueClass(todo)}>{formatDue(todo.dueAt)}</span>
                )}
                {todo.done && todo.completedBy && (
                  <span className="todos__by">✓ {todo.completedBy}</span>
                )}
              </span>
            </span>
            <button
              className="todos__delete"
              aria-label={`刪除 ${todo.text}`}
              title={confirming === todo.id ? '再按一次確認刪除' : '刪除'}
              onClick={() => void remove(todo.id)}
              onBlur={() => setConfirming((id) => (id === todo.id ? null : id))}
            >
              {confirming === todo.id ? '確認刪除' : '🗑'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/** Overdue only matters while the item is still open — a finished one is not late. */
export function dueClass(todo: Pick<Todo, 'done' | 'dueAt'>): string {
  const overdue = !todo.done && todo.dueAt !== undefined && new Date(todo.dueAt) < new Date()
  return overdue ? 'todos__due-at todos__due-at--overdue' : 'todos__due-at'
}

export function formatDue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * `datetime-local` gives a wall-clock string with no zone. The browser's own
 * zone is the only sensible reading of what the user typed, and the server
 * stores instants — so it is converted here rather than sent as-is.
 */
export function localInputToInstant(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}
