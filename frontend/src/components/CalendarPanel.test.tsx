import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CalendarPanel, formatDay, formatRange, groupByDay } from './CalendarPanel'
import type { CalendarEvent } from '../signaling/types'

const event = (id: number, startsAt: string, endsAt?: string): CalendarEvent => ({
  id,
  room: 'r',
  title: `事項 ${id}`,
  description: '',
  startsAt,
  endsAt,
  createdBy: 'alice',
  createdAt: '2026-08-01T10:00:00Z',
})

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const noop = () => Promise.resolve()
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('新增行事曆事項'), { target: { value } })

describe('CalendarPanel', () => {
  it('says so when there is nothing coming', () => {
    render(<CalendarPanel events={[]} onAdd={noop} onDelete={noop} />)
    expect(screen.getByText(/接下來沒有安排/)).toBeTruthy()
  })

  it('captures an entry from one line', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<CalendarPanel events={[]} onAdd={onAdd} onDelete={noop} />)

    type('週會 明天14:00')
    await act(async () => screen.getByRole('button', { name: '加入' }).click())

    const [title, startsAt, endsAt] = onAdd.mock.calls[0]
    expect(title).toBe('週會')
    expect(new Date(startsAt).getHours()).toBe(14)
    // No end was named; empty is what "no end" has to look like, not an
    // invalid date the server would refuse.
    expect(endsAt).toBe('')
  })

  it('asks for a time instead of silently refusing to submit', async () => {
    // An entry with no time cannot be placed on a calendar at all, so the
    // disabled button needs to say why.
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<CalendarPanel events={[]} onAdd={onAdd} onDelete={noop} />)

    type('週會')
    await waitFor(() => expect(screen.getByText('還需要時間')).toBeTruthy())
    await act(async () => screen.getByRole('button', { name: '加入' }).click())
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('leads each row with how far off it is', () => {
    render(<CalendarPanel events={[event(1, inHours(3))]} onAdd={noop} onDelete={noop} />)
    expect(screen.getByText(/3 小時後/)).toBeTruthy()
  })

  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<CalendarPanel events={[event(1, inHours(3))]} onAdd={noop} onDelete={onDelete} />)

    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('reports a refused deletion', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('只有主持人可以刪除'))
    render(<CalendarPanel events={[event(1, inHours(3))]} onAdd={noop} onDelete={onDelete} />)

    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    await waitFor(() => expect(screen.getByText(/只有主持人/)).toBeTruthy())
  })
})

describe('groupByDay', () => {
  it('keeps the server ordering rather than re-sorting', () => {
    const events = [
      event(1, '2026-08-09T09:00:00Z'),
      event(2, '2026-08-09T14:00:00Z'),
      event(3, '2026-08-10T09:00:00Z'),
    ]
    const grouped = groupByDay(events)
    expect(grouped).toHaveLength(2)
    expect(grouped[0][1].map((e) => e.id)).toEqual([1, 2])
    expect(grouped[1][1].map((e) => e.id)).toEqual([3])
  })

  it('returns nothing for an empty calendar', () => {
    expect(groupByDay([])).toEqual([])
  })
})

describe('formatDay', () => {
  const now = new Date(2026, 7, 5, 12, 0)

  it('names today and tomorrow, because that is what people call them', () => {
    expect(formatDay(new Date(2026, 7, 5, 18, 0).toISOString(), now)).toBe('今天')
    expect(formatDay(new Date(2026, 7, 6, 9, 0).toISOString(), now)).toBe('明天')
  })

  it('falls back to a date further out', () => {
    const label = formatDay(new Date(2026, 7, 12, 9, 0).toISOString(), now)
    expect(label).not.toBe('今天')
    expect(label).not.toBe('明天')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatDay('nonsense', now)).toBe('nonsense')
  })
})

describe('formatRange', () => {
  it('shows a single time for an entry with no end', () => {
    expect(formatRange({ startsAt: '2026-08-09T09:00:00Z', endsAt: undefined })).not.toContain('–')
  })

  it('shows a range when there is an end', () => {
    expect(
      formatRange({ startsAt: '2026-08-09T09:00:00Z', endsAt: '2026-08-09T10:00:00Z' }),
    ).toContain('–')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatRange({ startsAt: 'nonsense', endsAt: undefined })).toBe('nonsense')
  })
})
