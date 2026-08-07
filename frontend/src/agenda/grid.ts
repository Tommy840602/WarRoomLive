/**
 * Laying items out on a time grid.
 *
 * The calendar view was a list grouped by day, which answers "what is on
 * Thursday" but not "is Thursday afternoon free" — and the second question is
 * the one a grid answers and a list cannot. So this computes what a Google-style
 * week view needs: which days are on screen, where in the day each item sits,
 * and how overlapping items share the width.
 *
 * All of it is pure and takes `now` as an argument, because a grid is nothing
 * but arithmetic on local time and arithmetic is worth testing.
 */

import type { AgendaItem } from './item'

export const DAY_MS = 86_400_000

/**
 * Shortest block a reader can still aim a pointer at.
 *
 * An item with no end is a moment, and a moment is zero pixels tall. Google
 * draws those at about half an hour; the label still carries the real time, so
 * nothing is claimed about duration that is not true.
 */
export const MIN_BLOCK_MINUTES = 30

export interface Block {
  item: AgendaItem
  /** Fraction of the day, 0 at midnight — multiply by the column height. */
  top: number
  height: number
  /** Which of `lanes` side-by-side columns this block occupies. */
  lane: number
  lanes: number
  /** True when this is the tail of something that started on an earlier day. */
  continues: boolean
}

export function startOfDay(date: Date): Date {
  const out = new Date(date)
  out.setHours(0, 0, 0, 0)
  return out
}

export function addDays(from: Date, days: number): Date {
  const out = new Date(from)
  out.setDate(out.getDate() + days)
  return out
}

export function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime()
}

/**
 * The days on screen, aligned to the week the anchor falls in.
 *
 * Week-aligned rather than "the next seven days" because that is what a
 * calendar is: people say "Thursday" and expect it in the same place every
 * time. `firstDay` is the locale's first day of the week — 0 for Sunday.
 *
 * A count below seven is a narrow panel, and there the alignment would put
 * today off screen more often than not, so those start at the anchor instead.
 */
export function daysOnScreen(anchor: Date, count: number, firstDay = 0): Date[] {
  const start =
    count >= 7
      ? addDays(startOfDay(anchor), -(((anchor.getDay() - firstDay) % 7) + 7) % 7)
      : startOfDay(anchor)
  return Array.from({ length: count }, (_, i) => addDays(start, i))
}

/** How far through the day a moment is, as a fraction. */
export function fractionOfDay(at: Date): number {
  return (at.getTime() - startOfDay(at).getTime()) / DAY_MS
}

/**
 * The items that touch a given day, positioned and lane-assigned.
 *
 * An item spanning midnight appears on every day it touches, clipped to that
 * day and flagged `continues` on the later ones — a block that starts at 00:00
 * with no explanation reads as a meeting nobody scheduled.
 */
export function layOutDay(items: AgendaItem[], day: Date): Block[] {
  const dayStart = startOfDay(day).getTime()
  const dayEnd = dayStart + DAY_MS
  const minHeight = MIN_BLOCK_MINUTES / (24 * 60)

  const placed = items
    .filter((item) => item.at)
    .map((item) => {
      const start = new Date(item.at as string).getTime()
      if (Number.isNaN(start)) return null
      const rawEnd = item.endsAt ? new Date(item.endsAt).getTime() : start
      const end = Number.isNaN(rawEnd) ? start : rawEnd
      // Half-open: something ending exactly at midnight belongs to the day it
      // ran in, not to the empty one after it.
      if (end < dayStart || start >= dayEnd) return null
      if (end === dayStart && start < dayStart) return null

      const from = Math.max(start, dayStart)
      const to = Math.min(Math.max(end, start), dayEnd)
      const top = (from - dayStart) / DAY_MS
      return {
        item,
        start: from,
        end: to,
        top,
        // The minimum is a floor, not a licence to run past midnight: an item
        // at 23:45 has fifteen minutes of day left and gets fifteen minutes of
        // block. Clipping is honest; growing the block downwards would draw it
        // into tomorrow, and pulling it upwards would misstate when it starts.
        height: Math.min(Math.max((to - from) / DAY_MS, minHeight), 1 - top),
        continues: start < dayStart,
      }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => a.start - b.start || (a.item.key < b.item.key ? -1 : 1))

  return assignLanes(placed).map(({ start: _s, end: _e, ...block }) => block)
}

interface Placed {
  item: AgendaItem
  start: number
  end: number
  top: number
  height: number
  continues: boolean
}

/**
 * Splits overlapping blocks into side-by-side lanes.
 *
 * Lanes are counted **per cluster** of mutually overlapping items, not per day.
 * Counting per day would make a single pair of clashing meetings squeeze every
 * other block on that day to half width, which reads as a much busier day than
 * it is.
 *
 * Within a cluster the assignment is the greedy one: reuse the first lane whose
 * previous block has finished. Compared against the visual comparison the eye
 * makes, that is enough — the point is only that two things at once are visibly
 * two things at once.
 */
function assignLanes(placed: Placed[]): (Placed & { lane: number; lanes: number })[] {
  const out: (Placed & { lane: number; lanes: number })[] = []
  let cluster: (Placed & { lane: number })[] = []
  let clusterEnd = -Infinity
  // Blocks shorter than the minimum are still drawn at the minimum, so overlap
  // has to be judged on what is drawn or two touching moments render on top of
  // each other.
  const drawnEnd = (b: Placed) => Math.max(b.end, b.start + MIN_BLOCK_MINUTES * 60_000)

  const flush = () => {
    const lanes = cluster.reduce((max, b) => Math.max(max, b.lane + 1), 0)
    for (const b of cluster) out.push({ ...b, lanes })
    cluster = []
    clusterEnd = -Infinity
  }

  for (const block of placed) {
    if (block.start >= clusterEnd && cluster.length) flush()
    const laneEnds: number[] = []
    for (const b of cluster) laneEnds[b.lane] = Math.max(laneEnds[b.lane] ?? -Infinity, drawnEnd(b))
    let lane = laneEnds.findIndex((end) => end <= block.start)
    if (lane === -1) lane = laneEnds.length === 0 ? 0 : laneEnds.length
    cluster.push({ ...block, lane })
    clusterEnd = Math.max(clusterEnd, drawnEnd(block))
  }
  if (cluster.length) flush()
  return out
}

/**
 * How many day columns fit, given the space there is.
 *
 * Never more than a week, never fewer than one. A column narrower than this is
 * not a column, it is a stripe — the panel is better off showing three days
 * properly than seven illegibly.
 */
export const MIN_COLUMN_PX = 86
export const GUTTER_PX = 40

export function columnsFor(width: number): number {
  const usable = width - GUTTER_PX
  return Math.max(1, Math.min(7, Math.floor(usable / MIN_COLUMN_PX)))
}

/**
 * The hour the grid should open on: an hour before now, clamped into the day.
 *
 * Opening at midnight means every reader scrolls past eight empty hours before
 * seeing anything, every time.
 */
export function openingHour(now: Date): number {
  return Math.max(0, Math.min(23, now.getHours() - 1))
}
