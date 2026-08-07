import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TodoPanel, dueClass, formatDue, localInputToInstant } from './TodoPanel'
import type { Todo } from '../signaling/types'

const base: Todo = {
  id: 1,
  room: 'r',
  text: '訂會議室',
  done: false,
  createdBy: 'alice',
  createdAt: '2026-08-01T10:00:00Z',
}

const todos: Todo[] = [
  { ...base, id: 1, text: '訂會議室', assignee: 'bob', dueAt: '2026-08-09T09:00:00Z' },
  { ...base, id: 2, text: '寄簡報', done: true, completedAt: '2026-08-02T10:00:00Z', completedBy: 'alice' },
]

const noop = () => Promise.resolve()

describe('TodoPanel', () => {
  it('counts what is still open, not the whole list', () => {
    // "2/2" on a list where half is finished is the wrong reassurance.
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={noop} />)
    expect(screen.getByText(/待辦 \(1\/2\)/)).toBeTruthy()
  })

  it('will not submit an empty item', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={noop} onDelete={noop} />)

    fireEvent.change(screen.getByLabelText('待辦事項'), { target: { value: '   ' } })
    await act(async () => screen.getByRole('button', { name: '新增' }).click())
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('clears the form only after the item was accepted', async () => {
    // Clearing on failure loses what the user typed.
    const onAdd = vi.fn().mockRejectedValue(new Error('操作失敗(HTTP 500)'))
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={noop} onDelete={noop} />)

    const input = screen.getByLabelText('待辦事項') as HTMLInputElement
    fireEvent.change(input, { target: { value: '訂便當' } })
    await act(async () => screen.getByRole('button', { name: '新增' }).click())

    await waitFor(() => expect(screen.getByText(/操作失敗/)).toBeTruthy())
    expect(input.value).toBe('訂便當')
  })

  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={onDelete} />)

    const del = screen.getByRole('button', { name: '刪除 訂會議室' })
    await act(async () => del.click())
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => screen.getByRole('button', { name: '刪除 訂會議室' }).click())
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('reports a refused deletion rather than looking like it worked', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('只有主持人可以刪除'))
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={onDelete} />)

    await act(async () => screen.getByRole('button', { name: '刪除 訂會議室' }).click())
    await act(async () => screen.getByRole('button', { name: '刪除 訂會議室' }).click())
    await waitFor(() => expect(screen.getByText(/只有主持人/)).toBeTruthy())
  })

  it('toggles with the checkbox state, both ways', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined)
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={onToggle} onDelete={noop} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('完成 訂會議室'))
    })
    expect(onToggle).toHaveBeenCalledWith(1, true)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('完成 寄簡報'))
    })
    expect(onToggle).toHaveBeenLastCalledWith(2, false)
  })
})

describe('dueClass', () => {
  it('flags an open item that is past its due date', () => {
    expect(dueClass({ done: false, dueAt: '2020-01-01T00:00:00Z' })).toContain('overdue')
  })

  it('never flags a finished one', () => {
    // A completed task is not late; marking it red is noise that trains people
    // to ignore the colour.
    expect(dueClass({ done: true, dueAt: '2020-01-01T00:00:00Z' })).not.toContain('overdue')
  })

  it('never flags one with no due date', () => {
    expect(dueClass({ done: false, dueAt: undefined })).not.toContain('overdue')
  })
})

describe('localInputToInstant', () => {
  it('turns a wall-clock input into a UTC instant', () => {
    // datetime-local has no zone; the browser's own is the only sensible
    // reading, and the server stores instants.
    const iso = localInputToInstant('2026-08-09T09:00')
    expect(iso.endsWith('Z')).toBe(true)
    expect(new Date(iso).getHours()).toBe(9)
  })

  it('maps an empty or unparseable value to an empty string, not to an invalid date', () => {
    expect(localInputToInstant('')).toBe('')
    expect(localInputToInstant('not a date')).toBe('')
  })
})

describe('formatDue', () => {
  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatDue('nonsense')).toBe('nonsense')
  })
})
