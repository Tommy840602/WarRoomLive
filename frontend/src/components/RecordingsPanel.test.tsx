import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RecordingsPanel, type Recording } from './RecordingsPanel'

const recordings: Recording[] = [
  { id: 1, room: 'r', sizeBytes: 2_100_000, durationMs: 65_000, endedAt: '2026-08-01T10:00:00Z' },
  { id: 2, room: 'r', sizeBytes: 4_200_000, durationMs: 30_000, endedAt: '2026-08-02T10:00:00Z' },
]

const deleteButtons = () => screen.getAllByRole('button', { name: /刪除/ })

describe('RecordingsPanel', () => {
  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <RecordingsPanel recordings={recordings} onRequestUrl={vi.fn()} onDelete={onDelete} />,
    )

    // Deleting a recording cannot be undone, so one stray click must not do it.
    await act(async () => deleteButtons()[0].click())
    expect(onDelete).not.toHaveBeenCalled()
    expect(deleteButtons()[0].textContent).toBe('確認刪除')

    await act(async () => deleteButtons()[0].click())
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('arms only the row that was pressed', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <RecordingsPanel recordings={recordings} onRequestUrl={vi.fn()} onDelete={onDelete} />,
    )

    await act(async () => deleteButtons()[0].click())
    // Confirming the first must not be confirmation for the second.
    await act(async () => deleteButtons()[1].click())
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('reports a failed deletion instead of pretending it worked', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('刪除失敗(HTTP 502)'))
    render(
      <RecordingsPanel recordings={recordings} onRequestUrl={vi.fn()} onDelete={onDelete} />,
    )

    await act(async () => deleteButtons()[0].click())
    await act(async () => deleteButtons()[0].click())
    await waitFor(() => expect(screen.getByText(/刪除失敗/)).toBeTruthy())
  })

  it('closes the player when the recording it was playing is deleted', async () => {
    const onRequestUrl = vi.fn().mockResolvedValue('http://example/one.mp4')
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <RecordingsPanel
        recordings={recordings}
        onRequestUrl={onRequestUrl}
        onDelete={onDelete}
      />,
    )

    await act(async () => screen.getAllByRole('button', { name: '▶' })[0].click())
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toBe(
        'http://example/one.mp4',
      ),
    )

    await act(async () => deleteButtons()[0].click())
    await act(async () => deleteButtons()[0].click())
    // The URL still points at a file that no longer exists.
    await waitFor(() => expect(container.querySelector('video')).toBeNull())
  })
})
