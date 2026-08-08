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

  it('switches to a time grid of the same items', async () => {
    const { container } = panel({
      todos: [todo({ id: 1, text: '沒有時間的事' })],
      events: [event({ id: 1, title: '週會', startsAt: inHours(2) })],
    })

    await act(async () => screen.getByRole('button', { name: '行事曆' }).click())
    expect(screen.getByText('週會')).toBeTruthy()
    // A grid, not a list: the item is a positioned block on a day column.
    expect(container.querySelector('.slot')).toBeTruthy()
    expect(container.querySelectorAll('.grid__column').length).toBeGreaterThan(0)
    // An undated item cannot be placed on a grid, so it is counted rather than
    // quietly dropped.
    expect(screen.getByText(/另有 1 個沒有時間的項目/)).toBeTruthy()
    expect(within(container).queryByText('沒有時間的事')).toBeNull()
  })

  it('still draws the grid when nothing is booked, because free time is the answer', async () => {
    // A list has nothing to show and says so; a calendar showing an empty
    // Thursday has answered the question.
    const { container } = panel({ todos: [todo({ id: 1, text: '沒有時間的事' })] })
    await act(async () => screen.getByRole('button', { name: '行事曆' }).click())
    expect(container.querySelectorAll('.grid__column').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.slot')).toHaveLength(0)
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

describe('the clock', () => {
  it('moves an item into 現在 when its time arrives, with nothing else changing', async () => {
    // The defect this exists for: the bands were computed in a useMemo keyed on
    // the items, so the clock only ever spoke when something else did. An item
    // whose due time arrived sat in 稍後 until an unrelated edit.
    vi.useFakeTimers()
    try {
      const soon = new Date(Date.now() + 25 * 3_600_000).toISOString()
      const { container } = render(
        <AgendaPanel
          todos={[todo({ id: 1, text: '快到了', dueAt: soon })]}
          events={[]}
          onAdd={noop}
          onTriage={noop}
          onDelete={noop}
        />,
      )
      expect(bandOf(container, '快到了')).toBe('稍後')

      // Two hours pass. The props never change.
      await act(async () => {
        vi.advanceTimersByTime(2 * 3_600_000)
      })
      expect(bandOf(container, '快到了')).toBe('現在')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the grid the same clock as the board', () => {
    // Two views of one agenda disagreeing about whether something is 現在 is
    // worse than either being wrong on its own.
    const { container } = render(
      <AgendaPanel
        todos={[]}
        events={[event({ id: 1, title: '現在的事', startsAt: inHours(1) })]}
        onAdd={noop}
        onTriage={noop}
        onDelete={noop}
      />,
    )
    expect(bandOf(container, '現在的事')).toBe('現在')
    act(() => {
      screen.getByRole('button', { name: '行事曆' }).click()
    })
    expect(container.querySelector('.slot--now')).toBeTruthy()
  })
})

describe('@ mentions', () => {
  const withMembers = (members: string[]) =>
    render(
      <AgendaPanel
        todos={[]}
        events={[]}
        members={members}
        onAdd={noop}
        onTriage={noop}
        onDelete={noop}
      />,
    )

  const input = () => screen.getByLabelText('新增項目') as HTMLInputElement

  it('shows the room when an @ is typed', () => {
    // Typing @ and seeing who is here is what makes this discoverable rather
    // than a syntax you have to already know.
    withMembers(['Alice', 'Bob'])
    fireEvent.change(input(), { target: { value: '寄簡報 @' } })
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['@Alice', '@Bob'])
  })

  it('narrows as the name is typed', () => {
    withMembers(['Alice', 'Bob', 'Michal'])
    fireEvent.change(input(), { target: { value: '@al' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['@Alice', '@Michal'])
  })

  it('offers nothing where there is no mention', () => {
    withMembers(['Alice'])
    fireEvent.change(input(), { target: { value: '寄簡報 明天15:00' } })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('completes on Enter without submitting the form', () => {
    // Enter inside the picker must not send a half-typed name.
    const onAdd = vi.fn()
    render(
      <AgendaPanel
        todos={[]}
        events={[]}
        members={['Alice']}
        onAdd={onAdd}
        onTriage={noop}
        onDelete={noop}
      />,
    )
    fireEvent.change(input(), { target: { value: '寄簡報 @al' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('寄簡報 @Alice ')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('moves through the list with the arrow keys', () => {
    withMembers(['Alice', 'Bob'])
    fireEvent.change(input(), { target: { value: '@' } })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('@Bob ')
  })

  it('wraps rather than stopping at the end', () => {
    withMembers(['Alice', 'Bob'])
    fireEvent.change(input(), { target: { value: '@' } })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('@Bob ')
  })

  it('completes on a click', () => {
    withMembers(['Alice', 'Bob'])
    fireEvent.change(input(), { target: { value: '@b' } })
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Bob' }))
    expect(input().value).toBe('@Bob ')
  })

  it('closes on Escape and leaves the line alone', () => {
    // Dismissing means "I meant this literally", not "delete what I typed".
    withMembers(['Alice'])
    fireEvent.change(input(), { target: { value: '@al' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input().value).toBe('@al')
  })

  it('still accepts somebody who is not in the room', async () => {
    // The picker suggests; it does not restrict. A task can belong to someone
    // who has never opened this app.
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(
      <AgendaPanel
        todos={[]}
        events={[]}
        members={['Alice']}
        onAdd={onAdd}
        onTriage={noop}
        onDelete={noop}
      />,
    )
    fireEvent.change(input(), { target: { value: '寄簡報 @外包廠商' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    await act(async () => screen.getByRole('button', { name: '加入' }).click())
    expect(onAdd.mock.calls[0][0].assignee).toBe('外包廠商')
  })

  it('says it is a combobox, and which option is current', () => {
    withMembers(['Alice', 'Bob'])
    fireEvent.change(input(), { target: { value: '@' } })
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe('capture-mention-option-0')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input().getAttribute('aria-activedescendant')).toBe('capture-mention-option-1')
  })
})

describe('a range blocks the calendar', () => {
  it('keeps the owner when the line also names a range', async () => {
    // The bug this fixes: a span routed the line to the calendar, which had
    // nowhere to put a person, so @bob showed in the preview and then vanished.
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(
      <AgendaPanel todos={[]} events={[]} onAdd={onAdd} onTriage={noop} onDelete={noop} />,
    )
    fireEvent.change(screen.getByLabelText('新增項目'), {
      target: { value: '與法務對齊 @bob 明天14:00-15:00' },
    })
    await act(async () => screen.getByRole('button', { name: '加入' }).click())

    const [captured] = onAdd.mock.calls[0]
    expect(captured.assignee).toBe('bob')
    expect(captured.endAt).toBeDefined()
  })

  it('shows the stretch it is about to occupy, before it is sent', () => {
    // "1 天後" does not say how much of Thursday afternoon disappears.
    render(<AgendaPanel todos={[]} events={[]} onAdd={noop} onTriage={noop} onDelete={noop} />)
    fireEvent.change(screen.getByLabelText('新增項目'), {
      target: { value: '與法務對齊 明天14:00-15:00' },
    })
    expect(screen.getByText('14:00–15:00')).toBeTruthy()
  })

  it('draws an appointment on the grid as tall as it is long', () => {
    const { container } = render(
      <AgendaPanel
        todos={[]}
        events={[
          event({
            id: 1,
            title: '與法務對齊',
            startsAt: inHours(2),
            endsAt: inHours(4),
          }),
        ]}
        onAdd={noop}
        onTriage={noop}
        onDelete={noop}
      />,
    )
    act(() => {
      screen.getByRole('button', { name: '行事曆' }).click()
    })
    const slot = container.querySelector('.slot') as HTMLElement
    // Two hours at 44px per hour; the minimum block is half an hour, so a
    // height near the minimum would mean the range was ignored.
    expect(parseFloat(slot.style.height)).toBeGreaterThan(80)
  })
})
