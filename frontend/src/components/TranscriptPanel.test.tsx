import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptPanel } from './TranscriptPanel'
import type { Meeting, TranscriptLine } from '../signaling/types'

const MEETINGS: Meeting[] = [
  { id: 3, room: 'r', startedAt: '2026-08-08T09:00:00Z', participantPeak: 2, live: true },
  { id: 2, room: 'r', startedAt: '2026-08-07T09:00:00Z', participantPeak: 2 },
]

const LINES: TranscriptLine[] = [
  {
    id: 1,
    speaker: 'Alice',
    peerId: 'p1',
    lang: 'cmn-Hant-TW',
    text: '這個功能下週上線',
    spokenAt: '2026-08-08T09:01:00Z',
    translation: 'This feature ships next week',
    translationLang: 'en',
  },
  {
    id: 2,
    speaker: 'Bob',
    peerId: 'p2',
    lang: 'en-US',
    text: 'Good morning',
    spokenAt: '2026-08-08T09:02:00Z',
  },
]

const SUMMARY = {
  meetingId: 3,
  summaryMd: '## 重點\n- 談了上線時程\n\n## 待辦\n- [ ] 修好登入 — @小明\n',
  model: 'devai-phrasebook',
  lineCount: 2,
  generatedAt: '2026-08-08T10:00:00Z',
}

const panel = (over: Partial<Parameters<typeof TranscriptPanel>[0]> = {}) =>
  render(
    <TranscriptPanel
      lines={LINES}
      meetings={MEETINGS}
      summary={null}
      canSummarize
      onSummarize={vi.fn().mockResolvedValue(undefined)}
      onAddTask={vi.fn()}
      {...over}
    />,
  )

describe('TranscriptPanel', () => {
  it('shows both languages when a line has been translated', () => {
    panel()
    expect(screen.getByText('這個功能下週上線')).toBeTruthy()
    expect(screen.getByText('This feature ships next week')).toBeTruthy()
  })

  it('filters on the translation too, not only the original', () => {
    // Somebody reading the English track searches in English; a filter that only
    // matched what was spoken would find nothing for them.
    panel()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ships next' } })
    expect(screen.queryByText('Good morning')).toBeNull()
    expect(screen.getByText('這個功能下週上線')).toBeTruthy()
  })

  it('says so when the filter matches nothing', () => {
    panel()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(screen.getByText(/沒有符合/)).toBeTruthy()
  })

  it('summarises the live meeting rather than an old one', async () => {
    // The room is occupied whenever somebody is looking at this panel, so the
    // meeting they mean is the one still running — not the newest closed one.
    const onSummarize = vi.fn().mockResolvedValue(undefined)
    panel({ onSummarize })
    fireEvent.click(screen.getByRole('button', { name: '產生重點摘要' }))
    expect(onSummarize).toHaveBeenCalledWith(3, false)
  })

  it('renders the summary sections and their action items', () => {
    panel({ summary: SUMMARY })
    expect(screen.getByRole('heading', { name: '重點' })).toBeTruthy()
    expect(screen.getByText('修好登入')).toBeTruthy()
    expect(screen.getByText('@小明')).toBeTruthy()
  })

  it('offers an action item to the to-do list as a capture line, owner included', () => {
    const onAddTask = vi.fn()
    panel({ summary: SUMMARY, onAddTask })
    fireEvent.click(screen.getByRole('button', { name: '加入待辦' }))
    expect(onAddTask).toHaveBeenCalledWith('修好登入 @小明')
  })

  it('will not add the same item twice', () => {
    // The button is the only record that it was added — the to-do list is a
    // different panel — so it has to hold that state itself.
    const onAddTask = vi.fn()
    panel({ summary: SUMMARY, onAddTask })
    const button = screen.getByRole('button', { name: '加入待辦' })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: '已加入' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '已加入' }))
    expect(onAddTask).toHaveBeenCalledTimes(1)
  })

  it('explains itself instead of hiding the button when no model is configured', () => {
    // A missing button reads as a bug; this reads as a deployment choice.
    panel({ canSummarize: false })
    expect(screen.queryByRole('button', { name: '產生重點摘要' })).toBeNull()
    expect(screen.getByText(/沒有設定語言模型/)).toBeTruthy()
  })

  it('surfaces the server\'s reason when a summary cannot be made', async () => {
    // "not enough transcript" is something the reader can act on; a generic
    // failure sends them looking for a bug that is not there.
    const onSummarize = vi.fn().mockRejectedValue(new Error('逐字稿太短,無法摘要'))
    panel({ onSummarize })
    fireEvent.click(screen.getByRole('button', { name: '產生重點摘要' }))
    expect((await screen.findByRole('alert')).textContent).toBe('逐字稿太短,無法摘要')
  })

  it('invites the room to switch captions on when there is nothing yet', () => {
    panel({ lines: [] })
    expect(screen.getByText(/開啟字幕之後/)).toBeTruthy()
  })
})
