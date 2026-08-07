import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  MIN_BLOCK_MINUTES,
  columnsFor,
  daysOnScreen,
  fractionOfDay,
  layOutDay,
  openingHour,
  sameDay,
} from './grid'
import type { AgendaItem } from './item'

/** A Wednesday, so week alignment has somewhere to move to in both directions. */
const DAY = new Date(2026, 7, 5)
const at = (h: number, m = 0) => new Date(2026, 7, 5, h, m).toISOString()

const item = (key: string, over: Partial<AgendaItem> = {}): AgendaItem => ({
  key,
  kind: 'event',
  id: 1,
  text: key,
  done: false,
  ...over,
})

describe('daysOnScreen', () => {
  it('aligns a full week so a weekday is always in the same place', () => {
    const days = daysOnScreen(DAY, 7, 0)
    expect(days).toHaveLength(7)
    expect(days[0].getDay()).toBe(0)
    expect(days.some((d) => sameDay(d, DAY))).toBe(true)
  })

  it('honours a locale whose week starts on Monday', () => {
    expect(daysOnScreen(DAY, 7, 1)[0].getDay()).toBe(1)
  })

  it('starts a short view at the anchor, so today cannot fall off screen', () => {
    // Aligned to the week, a three-day view on a Saturday would show
    // Sunday–Tuesday and hide the day you are on.
    const days = daysOnScreen(DAY, 3, 0)
    expect(sameDay(days[0], DAY)).toBe(true)
    expect(days).toHaveLength(3)
  })

  it('starts each day at midnight, not at the anchor time', () => {
    const days = daysOnScreen(new Date(2026, 7, 5, 16, 30), 3)
    expect(days[0].getHours()).toBe(0)
  })
})

describe('fractionOfDay', () => {
  it('measures how far through the day a moment is', () => {
    expect(fractionOfDay(new Date(2026, 7, 5, 0, 0))).toBe(0)
    expect(fractionOfDay(new Date(2026, 7, 5, 12, 0))).toBeCloseTo(0.5, 5)
    expect(fractionOfDay(new Date(2026, 7, 5, 18, 0))).toBeCloseTo(0.75, 5)
  })
})

describe('layOutDay', () => {
  it('positions a block by when it starts and how long it lasts', () => {
    const [block] = layOutDay([item('a', { at: at(9), endsAt: at(10) })], DAY)
    expect(block.top).toBeCloseTo(9 / 24, 5)
    expect(block.height).toBeCloseTo(1 / 24, 5)
    expect(block.continues).toBe(false)
  })

  it('gives a moment a block you can actually aim at', () => {
    // Zero duration is zero pixels; the label still carries the real time.
    const [block] = layOutDay([item('a', { at: at(9) })], DAY)
    expect(block.height).toBeCloseTo(MIN_BLOCK_MINUTES / (24 * 60), 5)
  })

  it('leaves out items with no time and items on other days', () => {
    expect(layOutDay([item('a')], DAY)).toHaveLength(0)
    expect(layOutDay([item('a', { at: new Date(2026, 7, 9, 9).toISOString() })], DAY)).toHaveLength(0)
  })

  it('ignores an unparseable time rather than throwing', () => {
    expect(layOutDay([item('a', { at: 'nonsense' })], DAY)).toHaveLength(0)
  })

  it('shows a block on every day it crosses, flagged where it did not begin', () => {
    const overnight = item('a', {
      at: new Date(2026, 7, 5, 23, 0).toISOString(),
      endsAt: new Date(2026, 7, 6, 1, 0).toISOString(),
    })
    const first = layOutDay([overnight], DAY)[0]
    const second = layOutDay([overnight], new Date(2026, 7, 6))[0]

    expect(first.continues).toBe(false)
    expect(first.top).toBeCloseTo(23 / 24, 5)
    expect(first.top + first.height).toBeCloseTo(1, 5)

    // A block starting at 00:00 with no explanation reads as a meeting nobody
    // scheduled.
    expect(second.continues).toBe(true)
    expect(second.top).toBe(0)
    expect(second.height).toBeCloseTo(1 / 24, 5)
  })

  it('keeps something ending exactly at midnight on the day it ran in', () => {
    const untilMidnight = item('a', {
      at: new Date(2026, 7, 5, 22, 0).toISOString(),
      endsAt: new Date(2026, 7, 6, 0, 0).toISOString(),
    })
    expect(layOutDay([untilMidnight], DAY)).toHaveLength(1)
    expect(layOutDay([untilMidnight], new Date(2026, 7, 6))).toHaveLength(0)
  })

  it('treats an end before its start as a moment rather than a negative block', () => {
    const [block] = layOutDay([item('a', { at: at(9), endsAt: at(8) })], DAY)
    expect(block.height).toBeGreaterThan(0)
  })

  it('puts two things at once side by side', () => {
    const blocks = layOutDay(
      [item('a', { at: at(9), endsAt: at(11) }), item('b', { at: at(10), endsAt: at(12) })],
      DAY,
    )
    expect(blocks.map((b) => b.lane)).toEqual([0, 1])
    expect(blocks.every((b) => b.lanes === 2)).toBe(true)
  })

  it('reuses a lane once the earlier block has finished', () => {
    const blocks = layOutDay(
      [
        item('a', { at: at(9), endsAt: at(10) }),
        item('b', { at: at(9, 30), endsAt: at(11) }),
        item('c', { at: at(10, 30), endsAt: at(11, 30) }),
      ],
      DAY,
    )
    // c starts after a ends, so it takes a's lane rather than a third one.
    expect(blocks.map((b) => b.lane)).toEqual([0, 1, 0])
    expect(blocks.every((b) => b.lanes === 2)).toBe(true)
  })

  it('counts lanes per cluster, so one clash does not shrink the whole day', () => {
    const blocks = layOutDay(
      [
        item('a', { at: at(9), endsAt: at(10) }),
        item('b', { at: at(9), endsAt: at(10) }),
        item('c', { at: at(15), endsAt: at(16) }),
      ],
      DAY,
    )
    const alone = blocks.find((b) => b.item.key === 'c')!
    expect(alone.lanes).toBe(1)
    expect(blocks.filter((b) => b.item.key !== 'c').every((b) => b.lanes === 2)).toBe(true)
  })

  it('separates two moments at nearly the same time, which are drawn overlapping', () => {
    // They have no duration to clash over, but they are drawn at the minimum
    // height, so on screen they would sit on top of each other.
    const blocks = layOutDay([item('a', { at: at(9) }), item('b', { at: at(9, 10) })], DAY)
    expect(blocks.map((b) => b.lane)).toEqual([0, 1])
  })

  it('orders equal starts the same way on every client', () => {
    const one = layOutDay([item('b', { at: at(9) }), item('a', { at: at(9) })], DAY)
    const two = layOutDay([item('a', { at: at(9) }), item('b', { at: at(9) })], DAY)
    expect(one.map((b) => b.item.key)).toEqual(two.map((b) => b.item.key))
  })

  it('never places a block outside its day', () => {
    const blocks = layOutDay(
      [item('a', { at: at(23, 45), endsAt: new Date(DAY.getTime() + DAY_MS * 3).toISOString() })],
      DAY,
    )
    expect(blocks[0].top + blocks[0].height).toBeLessThanOrEqual(1.000001)
  })
})

describe('columnsFor', () => {
  it('never shows more than a week, nor fewer than one day', () => {
    expect(columnsFor(4000)).toBe(7)
    expect(columnsFor(0)).toBe(1)
    expect(columnsFor(-100)).toBe(1)
  })

  it('shows what fits rather than a week of stripes', () => {
    // A 320px rail is the default, and seven columns there would be 40px each.
    expect(columnsFor(320)).toBeLessThan(7)
    expect(columnsFor(320)).toBeGreaterThanOrEqual(1)
  })

  it('adds columns as the panel is widened', () => {
    expect(columnsFor(700)).toBeGreaterThan(columnsFor(320))
  })
})

describe('openingHour', () => {
  it('opens an hour before now, so the reader lands on something', () => {
    expect(openingHour(new Date(2026, 7, 5, 14, 30))).toBe(13)
  })

  it('stays inside the day at both ends', () => {
    expect(openingHour(new Date(2026, 7, 5, 0, 5))).toBe(0)
    expect(openingHour(new Date(2026, 7, 5, 23, 59))).toBe(22)
  })
})
