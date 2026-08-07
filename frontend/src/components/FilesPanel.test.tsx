import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilesPanel, formatSize } from './FilesPanel'
import type { Attachment } from '../signaling/types'

const files: Attachment[] = [
  {
    id: 1,
    room: 'r',
    filename: 'plan.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2_100_000,
    uploadedBy: 'alice',
    uploadedAt: '2026-08-01T10:00:00Z',
  },
  {
    id: 2,
    room: 'r',
    filename: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 900,
    uploadedBy: 'bob',
    uploadedAt: '2026-08-02T10:00:00Z',
  },
]

const noop = () => Promise.resolve()
const deleteButtons = () => screen.getAllByRole('button', { name: /刪除/ })

describe('FilesPanel', () => {
  it('does not delete on the first press', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <FilesPanel files={files} onUpload={noop} onRequestUrl={vi.fn()} onDelete={onDelete} />,
    )

    await act(async () => deleteButtons()[0].click())
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => deleteButtons()[0].click())
    expect(onDelete).toHaveBeenCalledWith(1)
  })

  it('surfaces a refused deletion rather than looking like it worked', async () => {
    // The server host-gates deletion, so a non-host pressing it gets a 403 —
    // and must be told, not left looking at a file that is still there.
    const onDelete = vi.fn().mockRejectedValue(new Error('只有主持人可以刪除'))
    render(
      <FilesPanel files={files} onUpload={noop} onRequestUrl={vi.fn()} onDelete={onDelete} />,
    )

    await act(async () => deleteButtons()[0].click())
    await act(async () => deleteButtons()[0].click())
    await waitFor(() => expect(screen.getByText(/只有主持人/)).toBeTruthy())
  })

  it('reports a failed upload and frees the control again', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('檔案太大'))
    const { container } = render(
      <FilesPanel files={[]} onUpload={onUpload} onRequestUrl={vi.fn()} onDelete={noop} />,
    )
    const input = container.querySelector('input[type=file]') as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'big.bin')] } })
    })

    await waitFor(() => expect(screen.getByText(/檔案太大/)).toBeTruthy())
    // A failed upload must not leave the picker disabled forever.
    expect(input.disabled).toBe(false)
  })

  it('opens a freshly signed URL when downloading', async () => {
    const onRequestUrl = vi.fn().mockResolvedValue('http://example/plan.pdf?X-Amz-Signature=abc')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <FilesPanel files={files} onUpload={noop} onRequestUrl={onRequestUrl} onDelete={noop} />,
    )

    await act(async () => screen.getAllByRole('button', { name: /下載/ })[0].click())
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'http://example/plan.pdf?X-Amz-Signature=abc',
        '_blank',
        'noopener',
      ),
    )
    open.mockRestore()
  })
})

describe('formatSize', () => {
  it('never rounds a real file down to nothing', () => {
    // "0 KB" next to a file that exists reads as a broken upload.
    expect(formatSize(1)).toBe('1 KB')
    expect(formatSize(900)).toBe('1 KB')
    expect(formatSize(2_100_000)).toBe('2.0 MB')
    expect(formatSize(0)).toBe('—')
  })
})
