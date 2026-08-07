import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TodoPanel } from './TodoPanel'
import type { Todo } from '../signaling/types'

const base: Todo = {
  id: 1,
  room: 'r',
  text: '訂會議室',
  done: false,
  createdBy: 'alice',
  createdAt: '2026-08-01T10:00:00Z',
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

const todos: Todo[] = [
  { ...base, id: 1, text: '訂會議室', assignee: 'bob', dueAt: inHours(-48) },
  { ...base, id: 2, text: '寄簡報', done: true, completedBy: 'alice', completedAt: inHours(-1) },
]

const noop = () => Promise.resolve()
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('新增待辦'), { target: { value } })

describe('TodoPanel', () => {
  it('counts what is still open, not the whole list', () => {
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={noop} />)
    expect(screen.getByText(/1 未完成/)).toBeTruthy()
  })

  it('captures a whole item from one line', async () => {
    // The point of the redesign: no tabbing through four fields mid-call.
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={noop} onDelete={noop} />)

    type('寄簡報 @bob 明天15:00')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())

    const [text, assignee, dueAt] = onAdd.mock.calls[0]
    expect(text).toBe('寄簡報')
    expect(assignee).toBe('bob')
    expect(new Date(dueAt).getHours()).toBe(15)
  })

  it('shows what the line was understood to mean before it is sent', async () => {
    // A parse the user only discovers afterwards is worse than no parse.
    render(<TodoPanel todos={[]} onAdd={noop} onToggle={noop} onDelete={noop} />)
    type('寄簡報 @bob 明天15:00')
    await waitFor(() => expect(screen.getByText('解讀為')).toBeTruthy())
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('adds no preview for a line with nothing to lift out', () => {
    render(<TodoPanel todos={[]} onAdd={noop} onToggle={noop} onDelete={noop} />)
    type('訂便當')
    expect(screen.queryByText('解讀為')).toBeNull()
  })

  it('will not submit an empty line', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={noop} onDelete={noop} />)

    type('   ')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('keeps the line when the server refuses it', async () => {
    // Clearing on failure loses what the user typed.
    const onAdd = vi.fn().mockRejectedValue(new Error('操作失敗(HTTP 500)'))
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={noop} onDelete={noop} />)

    const input = screen.getByLabelText('新增待辦') as HTMLInputElement
    type('訂便當')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())

    await waitFor(() => expect(screen.getByText(/操作失敗/)).toBeTruthy())
    expect(input.value).toBe('訂便當')
  })

  it('leads each row with how far off it is, not a timestamp', () => {
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={noop} />)
    expect(screen.getByText(/逾期 2 天/)).toBeTruthy()
  })

  it('flags an overdue item, and never a finished one', () => {
    const { container } = render(
      <TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={noop} />,
    )
    expect(container.querySelectorAll('.row__when--overdue')).toHaveLength(1)
    // The completed row is also "late" by the clock; colouring it red would
    // train people to ignore the colour.
    expect(container.querySelectorAll('.row--done .row__when--overdue')).toHaveLength(0)
  })

  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<TodoPanel todos={todos} onAdd={noop} onToggle={noop} onDelete={onDelete} />)

    await act(async () => screen.getByRole('button', { name: '刪除 訂會議室' }).click())
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

    await act(async () => fireEvent.click(screen.getByLabelText('完成 訂會議室')))
    expect(onToggle).toHaveBeenCalledWith(1, true)

    await act(async () => fireEvent.click(screen.getByLabelText('完成 寄簡報')))
    expect(onToggle).toHaveBeenLastCalledWith(2, false)
  })
})
