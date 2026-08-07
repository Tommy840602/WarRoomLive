import { describe, expect, it } from 'vitest'
import {
  NOW_WINDOW_MS,
  isAuto,
  mergeFeeds,
  sectionsOf,
  stampsOf,
  toItem,
  triageOf,
  type AgendaItem,
} from './item'
import type { CalendarEvent, Todo } from '../signaling/types'

const NOW = new Date('2026-08-07T12:00:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 1,
  room: 'r',
  text: '訂會議室',
  done: false,
  createdBy: 'alice',
  createdAt: at(-86_400_000),
  ...over,
})

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 1,
  room: 'r',
  title: '週會',
  description: '',
  startsAt: at(3_600_000),
  createdBy: 'alice',
  createdAt: at(-86_400_000),
  ...over,
})

const item = (over: Partial<AgendaItem> = {}): AgendaItem => ({
  key: 'todo:1',
  kind: 'todo',
  id: 1,
  text: '訂會議室',
  done: false,
  ...over,
})

describe('toItem', () => {
  it('keys the two feeds apart, because both tables number from 1', () => {
    expect(toItem(todo({ id: 7 })).key).not.toBe(toItem(event({ id: 7 })).key)
  })

  it('reads a calendar entry as an item with a start', () => {
    const out = toItem(event({ startsAt: at(0), endsAt: at(3_600_000), description: '每日站會' }))
    expect(out.text).toBe('週會')
    expect(out.note).toBe('每日站會')
    expect(out.at).toBe(at(0))
    expect(out.endsAt).toBe(at(3_600_000))
  })

  it('treats an entry from before calendars could be completed as open', () => {
    // Rows written before the migration have no `done` at all; defaulting it to
    // undefined would put them in neither section.
    expect(toItem(event()).done).toBe(false)
  })

  it('leaves an empty description off rather than showing a blank note line', () => {
    expect(toItem(event({ description: '' })).note).toBeUndefined()
  })
})

describe('stampsOf', () => {
  it('stamps a to-do as a task', () => {
    expect(stampsOf(item())).toEqual(['task'])
  })

  it('stamps a calendar entry as an appointment', () => {
    expect(stampsOf(item({ kind: 'event', key: 'event:1' }))).toEqual(['event'])
  })

  it('stamps a to-do that occupies a span as both', () => {
    // The facets are read off the item, not off the table it came from.
    expect(stampsOf(item({ at: at(0), endsAt: at(3_600_000) }))).toEqual(['task', 'event'])
  })

  it('does not stamp a due date as an appointment', () => {
    // Being due at 15:00 is not the same as occupying 15:00.
    expect(stampsOf(item({ at: at(3_600_000) }))).toEqual(['task'])
  })
})

describe('triageOf', () => {
  it('puts something happening soon in NOW', () => {
    expect(triageOf(item({ at: at(3_600_000) }), NOW)).toBe('now')
  })

  it('puts something past the horizon in LATER', () => {
    expect(triageOf(item({ at: at(NOW_WINDOW_MS + 60_000) }), NOW)).toBe('later')
  })

  it('keeps something overdue in NOW rather than letting it drift out', () => {
    expect(triageOf(item({ at: at(-86_400_000 * 3) }), NOW)).toBe('now')
  })

  it('puts an undated item in LATER, not in front of a room mid-incident', () => {
    expect(triageOf(item(), NOW)).toBe('later')
  })

  it('lets a stored decision overrule the clock, both ways', () => {
    expect(triageOf(item({ at: at(3_600_000), triage: 'LATER' }), NOW)).toBe('later')
    expect(triageOf(item({ at: at(86_400_000 * 30), triage: 'NOW' }), NOW)).toBe('now')
  })

  it('lets done outrank every opinion', () => {
    expect(triageOf(item({ at: at(60_000), triage: 'NOW', done: true }), NOW)).toBe('done')
  })

  it('files an unparseable time under LATER rather than throwing', () => {
    expect(triageOf(item({ at: 'nonsense' }), NOW)).toBe('later')
  })
})

describe('isAuto', () => {
  it('is true while nobody has overruled the clock', () => {
    expect(isAuto(item({ at: at(60_000) }))).toBe(true)
  })

  it('is false once the room decided, and once it is finished', () => {
    expect(isAuto(item({ triage: 'NOW' }))).toBe(false)
    expect(isAuto(item({ done: true }))).toBe(false)
  })
})

describe('mergeFeeds', () => {
  it('interleaves the two feeds by time rather than concatenating them', () => {
    const merged = mergeFeeds(
      [todo({ id: 1, dueAt: at(7_200_000) })],
      [event({ id: 1, startsAt: at(3_600_000) })],
    )
    expect(merged.map((i) => i.key)).toEqual(['event:1', 'todo:1'])
  })

  it('puts undated items last, where they cannot push dated ones down', () => {
    const merged = mergeFeeds([todo({ id: 1 }), todo({ id: 2, dueAt: at(60_000) })], [])
    expect(merged.map((i) => i.key)).toEqual(['todo:2', 'todo:1'])
  })

  it('breaks ties the same way on every client', () => {
    // Two clients disagreeing about the order is the failure this ordering
    // exists to prevent, so equal times must not fall back to input order.
    const a = mergeFeeds([todo({ id: 1, dueAt: at(0) })], [event({ id: 1, startsAt: at(0) })])
    const b = mergeFeeds([todo({ id: 1, dueAt: at(0) })], [event({ id: 1, startsAt: at(0) })])
    expect(a.map((i) => i.key)).toEqual(b.map((i) => i.key))
  })

  it('handles either feed being empty', () => {
    expect(mergeFeeds([], [])).toEqual([])
    expect(mergeFeeds([todo()], []).length).toBe(1)
  })
})

describe('sectionsOf', () => {
  it('sorts items into the three bands', () => {
    const sections = sectionsOf(
      [
        item({ key: 'a', at: at(60_000) }),
        item({ key: 'b', at: at(86_400_000 * 5) }),
        item({ key: 'c', done: true }),
      ],
      NOW,
    )
    expect(sections.now.map((i) => i.key)).toEqual(['a'])
    expect(sections.later.map((i) => i.key)).toEqual(['b'])
    expect(sections.done.map((i) => i.key)).toEqual(['c'])
  })

  it('reads the finished band backwards, newest first', () => {
    // Forwards, the thing you just ticked off ends up at the bottom of a list
    // nobody scrolls.
    const sections = sectionsOf(
      [
        item({ key: 'old', done: true, at: at(-86_400_000 * 2) }),
        item({ key: 'just-now', done: true, at: at(-60_000) }),
      ],
      NOW,
    )
    expect(sections.done.map((i) => i.key)).toEqual(['just-now', 'old'])
  })
})
