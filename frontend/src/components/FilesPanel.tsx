import { useRef, useState } from 'react'
import type { Attachment } from '../signaling/types'

interface FilesPanelProps {
  files: Attachment[]
  /** Uploads and returns once the server has recorded the file. */
  onUpload: (file: File, onProgress: (fraction: number) => void) => Promise<void>
  /** Fetches a fresh download URL — they are short-lived, so never cached. */
  onRequestUrl: (id: number) => Promise<string>
  onDelete: (id: number) => Promise<void>
}

/**
 * Files shared into this room.
 *
 * <p>Upload progress is real (an XHR, not fetch) because a file large enough to
 * be worth sharing is large enough that a spinner with no end in sight reads as
 * a hang. Downloads open a freshly signed URL rather than a stored one, for the
 * same reason recordings do.
 */
export function FilesPanel({ files, onUpload, onRequestUrl, onDelete }: FilesPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setProgress(0)
    try {
      await onUpload(file, setProgress)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
      // Without this the same file cannot be picked twice in a row: the input
      // keeps its value, so re-selecting it fires no change event.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const download = async (id: number) => {
    setError(null)
    try {
      window.open(await onRequestUrl(id), '_blank', 'noopener')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Two presses, like recordings — deleting a file someone else may still need
  // is not something a stray click should manage.
  const remove = async (id: number) => {
    if (confirming !== id) {
      setConfirming(id)
      return
    }
    setConfirming(null)
    setError(null)
    try {
      await onDelete(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="files">
      <h2 className="files__title">檔案 ({files.length})</h2>

      <input
        ref={inputRef}
        className="files__input"
        type="file"
        aria-label="選擇要分享的檔案"
        onChange={(e) => void upload(e.target.files?.[0])}
        disabled={progress !== null}
      />
      {progress !== null && (
        <progress className="files__progress" value={progress} max={1} aria-label="上傳進度" />
      )}
      {error && <p className="files__error">⚠️ {error}</p>}

      <ul className="files__list">
        {files.map((file) => (
          <li key={file.id} className="files__item">
            <button
              className="files__download"
              aria-label={`下載 ${file.filename}`}
              onClick={() => void download(file.id)}
            >
              ⬇
            </button>
            <span className="files__meta">
              <span className="files__name" title={file.filename}>{file.filename}</span>
              <span className="files__detail">
                {formatSize(file.sizeBytes)}・{file.uploadedBy}
              </span>
            </span>
            <button
              className="files__delete"
              aria-label={`刪除 ${file.filename}`}
              title={confirming === file.id ? '再按一次確認刪除' : '刪除檔案'}
              onClick={() => void remove(file.id)}
              onBlur={() => setConfirming((id) => (id === file.id ? null : id))}
            >
              {confirming === file.id ? '確認刪除' : '🗑'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
