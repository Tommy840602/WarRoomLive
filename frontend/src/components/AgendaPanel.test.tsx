import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgendaPanel, formatDay, formatWhen } from './AgendaPanel'
import type { CalendarEvent, Todo } from '../signaling/types'

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 1,
  room: 'r',
  text: '訂會議室',
  done: false,
  createdBy: 'alice',
  createdAt: inHours(-24),
  ...over,
})

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 1,
  room: 'r',
  title: '週會',
  description: '',
  startsAt: inHours(2),
  createdBy: 'alice',
  createdAt: inHours(-24),
  ...over,
})

const noop = () => Promise.resolve()
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('新增項目'), { target: { value } })

const panel = (over: Partial<Parameters<typeof AgendaPanel>[0]> = {}) =>
  render(
    <AgendaPanel
      todos={[]}
      events={[]}
      onAdd={noop}
      onTriage={noop}
      onDelete={noop}
      {...over}
    />,
  )

/** The band a piece of text ended up in — the only thing this board asserts. */
const bandOf = (container: HTMLElement, text: string) => {
  const bands = [...container.querySelectorAll('.band')]
  const found = bands.find((b) => b.textContent?.includes(text))
  return found?.querySelector('.band__label')?.textContent?.replace(/\d+$/, '') ?? null
}

describe('AgendaPanel', () => {
  it('shows one board, not a list and a calendar', () => {
    // The whole point of the redesign: a to-do and an appointment are the same
    // kind of thing, so they sit in the same bands.
    const { container } = panel({
      todos: [todo({ id: 1, text: '訂會議室', dueAt: inHours(1) })],
      events: [event({ id: 1, title: '週會', startsAt: inHours(2) })],
    })
    expect(bandOf(container, '訂會議室')).toBe('現在')
    expect(bandOf(container, '週會')).toBe('現在')
  })

  it('files a distant item under 稍後 and a finished one under 完成', () => {
    const { container } = panel({
      todos: [
        todo({ id: 1, text: '下個月的檢討', dueAt: inHours(24 * 20) }),
        todo({ id: 2, text: '關掉舊公告', done: true, completedBy: 'alice' }),
      ],
    })
    expect(bandOf(container, '下個月的檢討')).toBe('稍後')
    expect(bandOf(container, '關掉舊公告')).toBe('完成')
  })

  it('counts what is in front of people, not the whole board', () => {
    panel({
      todos: [
        todo({ id: 1, dueAt: inHours(1) }),
        todo({ id: 2, dueAt: inHours(24 * 9) }),
        todo({ id: 3, done: true }),
      ],
    })
    expect(screen.getByText(/1 現在 · 2 未完成/)).toBeTruthy()
  })

  it('cycles an item to the next band when its triage is pressed', async () => {
    const onTriage = vi.fn().mockResolvedValue(undefined)
    panel({ todos: [todo({ dueAt: inHours(1) })], onTriage })

    await act(async () => screen.getByLabelText(/訂會議室:現在/).click())
    expect(onTriage).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'later')
  })

  it('cycles a finished item back to the top rather than trapping it', async () => {
    const onTriage = vi.fn().mockResolvedValue(undefined)
    panel({ todos: [todo({ done: true })], onTriage })

    await act(async () => screen.getByLabelText(/訂會議室:完成/).click())
    expect(onTriage).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'now')
  })

  it('hands an item back to the clock on right-click', async () => {
    const onTriage = vi.fn().mockResolvedValue(undefined)
    panel({ todos: [todo({ dueAt: inHours(1), triage: 'LATER' })], onTriage })

    await act(async () =>
      fireEvent.contextMenu(screen.getByLabelText(/訂會議室:稍後/)),
    )
    expect(onTriage).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'auto')
  })

  it('marks an item the clock is still deciding, and one the room decided', () => {
    const { container } = panel({
      todos: [
        todo({ id: 1, text: '自動的', dueAt: inHours(1) }),
        todo({ id: 2, text: '講好的', dueAt: inHours(1), triage: 'NOW' }),
      ],
    })
    // "Nobody has looked at this" and "the room decided" are different states,
    // and a board that auto-triages has to show which is which.
    expect(container.querySelectorAll('.triage--auto')).toHaveLength(1)
  })

  it('reports a refused change instead of looking like it worked', async () => {
    const onTriage = vi.fn().mockRejectedValue(new Error('只有主持人可以刪除'))
    panel({ todos: [todo({ dueAt: inHours(1) })], onTriage })

    await act(async () => screen.getByLabelText(/訂會議室:現在/).click())
    await waitFor(() => expect(screen.getByText(/只有主持人/)).toBeTruthy())
  })

  it('captures a whole item from one line', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    panel({ onAdd })

    type('寄簡報 @bob 明天15:00')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())

    const [captured] = onAdd.mock.calls[0]
    expect(captured.text).toBe('寄簡報')
    expect(captured.assignee).toBe('bob')
    expect(new Date(captured.dueAt).getHours()).toBe(15)
    expect(captured.endAt).toBeUndefined()
  })

  it('says which stamp a line will get, before it is sent', async () => {
    // A one-line capture choosing "this is a meeting" silently is exactly the
    // thing that would make people distrust it.
    const { rerender } = panel()
    type('寄簡報 明天15:00')
    await waitFor(() => expect(screen.getByText('待辦')).toBeTruthy())

    rerender(
      <AgendaPanel todos={[]} events={[]} onAdd={noop} onTriage={noop} onDelete={noop} />,
    )
    type('與法務對齊 明天14:00-15:00')
    await waitFor(() => expect(screen.getByText('約會')).toBeTruthy())
  })

  it('adds no preview for a line with nothing to lift out', () => {
    panel()
    type('訂便當')
    expect(screen.queryByText('解讀為')).toBeNull()
  })

  it('will not submit an empty line', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    panel({ onAdd })

    type('   ')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('keeps the line when the server refuses it', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('操作失敗(HTTP 500)'))
    panel({ onAdd })

    const input = screen.getByLabelText('新增項目') as HTMLInputElement
    type('訂便當')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())

    await waitFor(() => expect(screen.getByText(/操作失敗/)).toBeTruthy())
    expect(input.value).toBe('訂便當')
  })

  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    panel({ todos: [todo()], onDelete })

    await act(async () => screen.getByRole('button', { name: '刪除 訂會議室' }).click())
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => screen.getByRole('button', { name: '刪除 訂會議室' }).click())
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 1, kind: 'todo' }))
  })

  it('deletes the entry the row belongs to, not the row with the same number', async () => {
    // Both tables number from 1, so an id alone cannot say which one to delete.
    const onDelete = vi.fn().mockResolvedValue(undefined)
    panel({ todos: [todo({ id: 1 })], events: [event({ id: 1 })], onDelete })

    const button = screen.getByRole('button', { name: '刪除 週會' })
    await act(async () => button.click())
    await act(async () => button.click())
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 1, kind: 'event' }))
  })

  it('switches to the calendar view of the same items', async () => {
    const { container } = panel({
      todos: [todo({ id: 1, text: '沒有時間的事' })],
      events: [event({ id: 1, title: '週會', startsAt: inHours(2) })],
    })

    await act(async () => screen.getByRole('button', { name: '行事曆' }).click())
    expect(screen.getByText('週會')).toBeTruthy()
    // An undated item cannot be placed on a calendar, so it is counted rather
    // than quietly dropped.
    expect(screen.getByText(/另有 1 個沒有時間的項目/)).toBeTruthy()
    expect(within(container).queryByText('沒有時間的事')).toBeNull()
  })

  it('says so when a calendar has nothing to place', async () => {
    panel({ todos: [todo({ id: 1, text: '沒有時間的事' })] })
    await act(async () => screen.getByRole('button', { name: '行事曆' }).click())
    expect(screen.getByText(/沒有排定時間的項目/)).toBeTruthy()
  })

  it('says so when the board is empty', () => {
    panel()
    expect(screen.getByText(/還沒有任何項目/)).toBeTruthy()
  })
})

describe('formatWhen', () => {
  it('shows an appointment as a clock time, because you turn up to it', () => {
    expect(
      formatWhen({ kind: 'event', at: '2026-08-09T09:00:00Z', endsAt: '2026-08-09T10:00:00Z' }),
    ).toContain('–')
  })

  it('shows a single time for an appointment with no end', () => {
    expect(formatWhen({ kind: 'event', at: '2026-08-09T09:00:00Z' })).not.toContain('–')
  })

  it('shows a task as how far off it is, because nobody turns up to a deadline', () => {
    expect(formatWhen({ kind: 'todo', at: inHours(3) })).toMatch(/小時後/)
  })

  it('names the day on the board, where there is no heading to say which', () => {
    // "16:37" on its own is an unanswerable question when the row could be
    // tomorrow.
    const now = new Date(2026, 7, 5, 12, 0)
    const tomorrow = new Date(2026, 7, 6, 16, 37).toISOString()
    expect(formatWhen({ kind: 'event', at: tomorrow }, true, now)).toContain('明天')
  })

  it('leaves today unqualified, because "今天 16:37" is just noise', () => {
    const now = new Date(2026, 7, 5, 12, 0)
    const later = new Date(2026, 7, 5, 16, 37).toISOString()
    expect(formatWhen({ kind: 'event', at: later }, true, now)).not.toContain('今天')
  })

  it('leaves the day off on the calendar, where the heading already says it', () => {
    const now = new Date(2026, 7, 5, 12, 0)
    const tomorrow = new Date(2026, 7, 6, 16, 37).toISOString()
    expect(formatWhen({ kind: 'event', at: tomorrow }, false, now)).not.toContain('明天')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatWhen({ kind: 'todo', at: 'nonsense' })).toBe('nonsense')
  })

  it('has nothing to say without a time', () => {
    expect(formatWhen({ kind: 'todo' })).toBe('')
  })
})

describe('formatDay', () => {
  const now = new Date(2026, 7, 5, 12, 0)

  it('names the days people name', () => {
    expect(formatDay(new Date(2026, 7, 5, 18, 0).toISOString(), now)).toBe('今天')
    expect(formatDay(new Date(2026, 7, 6, 9, 0).toISOString(), now)).toBe('明天')
    // The board reaches a week back, so yesterday is a day it really shows.
    expect(formatDay(new Date(2026, 7, 4, 9, 0).toISOString(), now)).toBe('昨天')
  })

  it('falls back to a date further out', () => {
    expect(formatDay(new Date(2026, 7, 12, 9, 0).toISOString(), now)).not.toBe('今天')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatDay('nonsense', now)).toBe('nonsense')
  })
})
