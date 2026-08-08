import { useEffect, useRef, useState } from 'react'

interface RoomAnnouncerProps {
  /** Display names currently in the room. */
  names: string[]
}

/**
 * Says out loud who came and went.
 *
 * <p>Someone joining or leaving is a visible change to the member list and to
 * the video grid, and a screen reader reader gets neither: the tiles are an
 * unlabelled reflow and the list is off in a panel that may not even be open.
 * In a meeting, "who is here" is not a detail.
 *
 * <p>`polite`, unlike the due banner: this should wait for a gap rather than
 * cut across whatever is being read. And it announces the *difference*, not the
 * roster — a region that re-reads five names every time somebody joins is one
 * people switch off.
 */
export function RoomAnnouncer({ names }: RoomAnnouncerProps) {
  const previous = useRef<string[] | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const before = previous.current
    previous.current = names
    // The first render is the room as found, not a series of arrivals.
    if (before === null) return

    const joined = names.filter((n) => !before.includes(n))
    const left = before.filter((n) => !names.includes(n))
    const parts: string[] = []
    if (joined.length) parts.push(`${joined.join('、')} 加入了`)
    if (left.length) parts.push(`${left.join('、')} 離開了`)
    if (parts.length) setMessage(parts.join(';'))
  }, [names])

  return (
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  )
}
