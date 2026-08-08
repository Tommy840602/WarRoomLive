import { useEffect, useState } from 'react'

/**
 * A clock that ticks, for anything whose answer depends on the time.
 *
 * The agenda board computes its bands from each item's due time, and did so in
 * a `useMemo` keyed on the items. Which meant the clock only ever spoke when
 * something else changed: an item sitting in 稍後 whose time arrived stayed
 * there until an unrelated edit forced a re-render. The whole "the clock
 * proposes and the room disposes" premise quietly did not hold while anyone was
 * looking at it — and the calendar grid, which *did* have a timer, disagreed
 * with the board about the same item.
 *
 * A minute is finer than anyone reads an agenda at, and coarse enough to cost
 * nothing. Everything time-dependent should take its `now` from here so the two
 * views cannot drift apart again.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const tick = () => setNow(new Date())
    const timer = window.setInterval(tick, intervalMs)
    // A laptop asleep past a due time wakes with a timer that never fired, and
    // would show yesterday's board until the next tick.
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [intervalMs])

  return now
}
