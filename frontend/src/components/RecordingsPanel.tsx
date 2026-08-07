import { useState } from 'react'

export interface Recording {
  id: number
  room: string
  sizeBytes: number
  durationMs: number
  startedAt?: string
  endedAt: string
}

interface RecordingsPanelProps {
  recordings: Recording[]
  /** Fetches a fresh playback URL — they are short-lived, so never cached. */
  onRequestUrl: (id: number) => Promise<string>
  /** Deletes the recording and its file. Irreversible, hence the confirmation. */
  onDelete: (id: number) => Promise<void>
}

/**
 * Finished recordings of this room, playable in place.
 *
 * <p>Playback URLs are fetched when the user actually presses play, not when
 * the list renders: they expire, so minting one per listed item would hand out
 * credentials nobody asked for and leave them to go stale.
 */
export function RecordingsPanel({ recordings, onRequestUrl, onDelete }: RecordingsPanelProps) {
  const [playing, setPlaying] = useState<{ id: number; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const play = async (id: number) => {
    setError(null)
    try {
      setPlaying({ id, url: await onRequestUrl(id) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Two presses rather than a browser confirm(): the dialog blocks the whole
  // page during a call, and this is a room people are talking in.
  const remove = async (id: number) => {
    if (confirming !== id) {
      setConfirming(id)
      return
    }
    setConfirming(null)
    setError(null)
    try {
      await onDelete(id)
      // The player would otherwise keep showing a URL for a file that is gone.
      if (playing?.id === id) setPlaying(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="recordings">
      <h2 className="recordings__title">錄影 ({recordings.length})</h2>
      {error && <p className="recordings__error">⚠️ {error}</p>}
      <ul className="recordings__list">
        {recordings.map((recording) => (
          <li key={recording.id} className="recordings__item">
            <button className="recordings__play" onClick={() => void play(recording.id)}>
              ▶
            </button>
            <span className="recordings__meta">
              <span className="recordings__when">{formatWhen(recording.endedAt)}</span>
              <span className="recordings__detail">
                {formatDuration(recording.durationMs)}・{formatSize(recording.sizeBytes)}
              </span>
            </span>
            <button
              className="recordings__delete"
              aria-label={`刪除 ${formatWhen(recording.endedAt)} 的錄影`}
              title={confirming === recording.id ? '再按一次確認刪除' : '刪除錄影'}
              onClick={() => void remove(recording.id)}
              onBlur={() => setConfirming((id) => (id === recording.id ? null : id))}
            >
              {confirming === recording.id ? '確認刪除' : '🗑'}
            </button>
          </li>
        ))}
      </ul>
      {playing && (
        <video className="recordings__player" src={playing.url} controls autoPlay />
      )}
    </aside>
  )
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
