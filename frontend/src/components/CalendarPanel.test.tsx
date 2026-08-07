import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CalendarPanel, formatRange, groupByDay } from './CalendarPanel'
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

const noop = () => Promise.resolve()

describe('CalendarPanel', () => {
  it('says so when there is nothing coming', () => {
    render(<CalendarPanel events={[]} onAdd={noop} onDelete={noop} />)
    expect(screen.getByText(/接下來沒有安排/)).toBeTruthy()
  })

  it('will not submit without both a title and a start', async () => {
    // An entry with no time cannot be placed on a calendar at all.
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<CalendarPanel events={[]} onAdd={onAdd} onDelete={noop} />)

    fireEvent.change(screen.getByLabelText('行事曆事項'), { target: { value: '週會' } })
    await act(async () => screen.getByRole('button', { name: '新增' }).click())
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('開始時間'), { target: { value: '2026-08-09T09:00' } })
    await act(async () => screen.getByRole('button', { name: '新增' }).click())
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('sends instants, not the raw wall-clock input', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<CalendarPanel events={[]} onAdd={onAdd} onDelete={noop} />)

    fireEvent.change(screen.getByLabelText('行事曆事項'), { target: { value: '週會' } })
    fireEvent.change(screen.getByLabelText('開始時間'), { target: { value: '2026-08-09T09:00' } })
    await act(async () => screen.getByRole('button', { name: '新增' }).click())

    const [, startsAt, endsAt] = onAdd.mock.calls[0]
    expect(startsAt.endsWith('Z')).toBe(true)
    // No end was given, and an empty string is what "no end" has to look like —
    // not an invalid date the server would refuse.
    expect(endsAt).toBe('')
  })

  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <CalendarPanel events={[event(1, '2026-08-09T09:00:00Z')]} onAdd={noop} onDelete={onDelete} />,
    )

    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('reports a refused deletion', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('只有主持人可以刪除'))
    render(
      <CalendarPanel events={[event(1, '2026-08-09T09:00:00Z')]} onAdd={noop} onDelete={onDelete} />,
    )

    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    await act(async () => screen.getByRole('button', { name: /刪除/ }).click())
    await waitFor(() => expect(screen.getByText(/只有主持人/)).toBeTruthy())
  })
})

describe('groupByDay', () => {
  it('keeps the server ordering rather than re-sorting', () => {
    // The server reads the calendar forwards; re-sorting here risks disagreeing
    // with it, and the panel would then show a different "next" than the API.
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

describe('formatRange', () => {
  it('shows a single time for an entry with no end', () => {
    // "09:00–" reads as unfinished rather than as a moment.
    const shown = formatRange({ startsAt: '2026-08-09T09:00:00Z', endsAt: undefined })
    expect(shown).not.toContain('–')
  })

  it('shows a range when there is an end', () => {
    const shown = formatRange({
      startsAt: '2026-08-09T09:00:00Z',
      endsAt: '2026-08-09T10:00:00Z',
    })
    expect(shown).toContain('–')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatRange({ startsAt: 'nonsense', endsAt: undefined })).toBe('nonsense')
  })
})
