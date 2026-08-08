import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MeetingsPanel, formatDuration, formatStart } from './MeetingsPanel'
import type { Meeting } from '../signaling/types'

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 1,
  room: 'r',
  startedAt: '2026-08-07T09:00:00Z',
  endedAt: '2026-08-07T10:30:00Z',
  participantPeak: 4,
  durationSeconds: 5400,
  ...over,
})

const noop = () => Promise.resolve()

describe('MeetingsPanel', () => {
  it('says so when the room has no history yet', () => {
    render(<MeetingsPanel meetings={[]} onExport={noop} />)
    expect(screen.getByText(/還沒有結束的會議/)).toBeTruthy()
  })

  it('shows how long a meeting ran and how busy it got', () => {
    render(<MeetingsPanel meetings={[meeting()]} onExport={noop} />)
    expect(screen.getByText('1 小時 30 分')).toBeTruthy()
    expect(screen.getByText('4 人')).toBeTruthy()
  })

  it('marks a meeting still running rather than measuring it against now', () => {
    // Its duration is not a fact yet, and presenting one would be inventing it.
    render(
      <MeetingsPanel
        meetings={[meeting({ endedAt: undefined, durationSeconds: undefined, live: true })]}
        onExport={noop}
      />,
    )
    expect(screen.getByText('進行中')).toBeTruthy()
  })

  it('hands back the record for the meeting whose row was pressed', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined)
    render(
      <MeetingsPanel meetings={[meeting({ id: 7 }), meeting({ id: 8 })]} onExport={onExport} />,
    )
    await act(async () => screen.getAllByRole('button', { name: '匯出' })[1].click())
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }))
  })

  it('reports a refused export instead of looking like it worked', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('匯出失敗(HTTP 500)'))
    render(<MeetingsPanel meetings={[meeting()]} onExport={onExport} />)
    await act(async () => screen.getByRole('button', { name: '匯出' }).click())
    await waitFor(() => expect(screen.getByText(/匯出失敗/)).toBeTruthy())
  })
})

describe('formatDuration', () => {
  it('uses the units people say it in', () => {
    expect(formatDuration(45)).toBe('45 秒')
    expect(formatDuration(600)).toBe('10 分')
    expect(formatDuration(3600)).toBe('1 小時')
    expect(formatDuration(5400)).toBe('1 小時 30 分')
  })

  it('does not round a short meeting down to "0 分"', () => {
    // Somebody joining and leaving is a real thing that happens, and "0 分"
    // reads as a bug rather than as what it is.
    expect(formatDuration(12)).toBe('12 秒')
    expect(formatDuration(0)).toBe('0 秒')
  })
})

describe('formatStart', () => {
  it('carries the date, because a history spans days', () => {
    const out = formatStart('2026-08-07T09:00:00Z')
    expect(out).not.toBe('2026-08-07T09:00:00Z')
    expect(out.length).toBeGreaterThan(5)
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatStart('nonsense')).toBe('nonsense')
  })
})
