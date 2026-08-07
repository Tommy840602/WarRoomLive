/**
 * One kind of thing.
 *
 * The room's list and its calendar were two panels because the database has two
 * tables, which is a reason the database has and the room does not. Chandler's
 * observation was that a to-do and an appointment are the same item wearing
 * different facets — Chandler called them stamps — and that making people
 * choose a facet *before* they can write the thing down is the rigidity. So the
 * two feeds are merged here into one item type, and the stamps are read off
 * what the item actually has rather than off which table it came from.
 *
 * The dashboard sorts those items into three sections — 現在 / 稍後 / 完成 —
 * which is triage: not a priority and not a deadline, but a decision about
 * attention. The clock proposes a section from the item's time; anyone in the
 * room can overrule it, and the override is stored, because in a war room "we
 * are dealing with this now" is a shared decision and not a personal view.
 */

import type { CalendarEvent, Todo } from '../signaling/types'

/** Where an item sits on the dashboard. */
export type Triage = 'now' | 'later' | 'done'

/**
 * A facet an item carries.
 *
 * `task` — somebody has to do it, so it can be ticked off.
 * `event` — it occupies time rather than merely being due at one.
 *
 * An item can carry both: `與法務對齊 @bob 明天14:00-15:00` is a meeting that is
 * also somebody's job.
 */
export type Stamp = 'task' | 'event'

export interface AgendaItem {
  /** Unique across both feeds — the two tables number their rows separately. */
  key: string
  kind: 'todo' | 'event'
  id: number
  text: string
  note?: string
  assignee?: string
  /** When it is due, or when it begins. */
  at?: string
  endsAt?: string
  done: boolean
  completedBy?: string
  /** The stored override, absent when the clock is still deciding. */
  triage?: 'NOW' | 'LATER'
}

/**
 * How far ahead the clock still calls something NOW.
 *
 * A day, because that is the horizon a room in session actually works on: what
 * is left today and what lands tomorrow morning. Longer and NOW fills up with
 * things nobody is going to touch this session, which is how a triage section
 * stops being read.
 */
export const NOW_WINDOW_MS = 24 * 3_600_000

export function toItem(todo: Todo): AgendaItem
export function toItem(event: CalendarEvent): AgendaItem
export function toItem(row: Todo | CalendarEvent): AgendaItem {
  if ('text' in row) {
    return {
      key: `todo:${row.id}`,
      kind: 'todo',
      id: row.id,
      text: row.text,
      assignee: row.assignee,
      at: row.dueAt,
      done: row.done,
      completedBy: row.completedBy,
      triage: row.triage,
    }
  }
  return {
    key: `event:${row.id}`,
    kind: 'event',
    id: row.id,
    text: row.title,
    note: row.description || undefined,
    at: row.startsAt,
    endsAt: row.endsAt,
    done: row.done ?? false,
    completedBy: row.completedBy,
    triage: row.triage,
  }
}

/**
 * Which facets this item carries.
 *
 * Read off the item, never off its table: an appointment that somebody owns is
 * both, and a to-do with a start and an end is an appointment however it was
 * created.
 */
export function stampsOf(item: AgendaItem): Stamp[] {
  const stamps: Stamp[] = []
  if (item.kind === 'todo') stamps.push('task')
  if (item.kind === 'event' || item.endsAt) stamps.push('event')
  return stamps
}

/**
 * The item's section.
 *
 * Order matters: done is a fact and outranks any opinion, a stored override is
 * a person and outranks the clock, and only then does the clock get a say. An
 * item with no time at all is LATER — the clock has nothing to go on, and
 * putting undated things in front of people who are mid-incident is how the NOW
 * column becomes noise.
 */
export function triageOf(item: AgendaItem, now: Date = new Date()): Triage {
  if (item.done) return 'done'
  if (item.triage) return item.triage === 'NOW' ? 'now' : 'later'
  if (!item.at) return 'later'
  const ms = new Date(item.at).getTime() - now.getTime()
  if (Number.isNaN(ms)) return 'later'
  return ms <= NOW_WINDOW_MS ? 'now' : 'later'
}

/** True while the clock is still deciding, so the UI can say so. */
export function isAuto(item: AgendaItem): boolean {
  return !item.done && !item.triage
}

/**
 * Both feeds as one list.
 *
 * The two feeds arrive separately ordered, so *something* has to interleave
 * them, and the project's "ordering is the server's" rule cannot survive
 * literally here. What that rule protects is that two clients never disagree
 * about what comes first, so the merge is a total order every client computes
 * identically: soonest first, undated last, ties broken by key.
 */
export function mergeFeeds(todos: Todo[], events: CalendarEvent[]): AgendaItem[] {
  return [...todos.map(toItem), ...events.map(toItem)].sort(compareItems)
}

function compareItems(a: AgendaItem, b: AgendaItem): number {
  const at = a.at ? new Date(a.at).getTime() : null
  const bt = b.at ? new Date(b.at).getTime() : null
  if (at === null && bt === null) return a.key < b.key ? -1 : 1
  if (at === null) return 1
  if (bt === null) return -1
  if (at !== bt) return at - bt
  return a.key < b.key ? -1 : 1
}

export interface Sections {
  now: AgendaItem[]
  later: AgendaItem[]
  done: AgendaItem[]
}

/**
 * The dashboard, in three sections.
 *
 * Done is reversed: the rest of the board reads forwards towards what has not
 * happened, but a finished list is read backwards — the thing you just ticked
 * is the one you want to see, and the oldest is the one you never look at.
 */
export function sectionsOf(items: AgendaItem[], now: Date = new Date()): Sections {
  const out: Sections = { now: [], later: [], done: [] }
  for (const item of items) out[triageOf(item, now)].push(item)
  out.done.reverse()
  return out
}
