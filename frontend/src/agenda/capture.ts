/**
 * One-line capture for the shared list and calendar.
 *
 * During a live call nobody tabs through four form fields, so a line is typed
 * the way it would be said — `寄簡報 @bob 明天15:00` — and the parts that are
 * unambiguously a person or a time are lifted out of it.
 *
 * The rule that keeps this honest: **anything not recognised stays in the
 * text.** A parser that quietly swallows words the user meant to keep is worse
 * than no parser, because the loss is invisible until someone reads the item
 * back and finds half of it missing.
 */

export interface Captured {
  text: string
  assignee?: string
  /** ISO-8601 instant, or undefined when no time was named. */
  dueAt?: string
  /**
   * End of the span, when the line named one (`14:00-15:00`).
   *
   * This is what stamps an item as an appointment rather than a task: a thing
   * with an end occupies time, and occupying time is what a meeting does.
   */
  endAt?: string
  /** Which fragments were consumed, so the input can show what it understood. */
  matched: string[]
}

const WEEKDAYS: Record<string, number> = {
  日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/** Date-only entries are due by the end of that day, not the start of it. */
const END_OF_DAY = { hours: 23, minutes: 59 }

export function parseCapture(input: string, now: Date = new Date()): Captured {
  let rest = input
  const matched: string[] = []

  const take = (pattern: RegExp): RegExpMatchArray | null => {
    const m = rest.match(pattern)
    if (!m) return null
    matched.push(m[0].trim())
    rest = (rest.slice(0, m.index) + ' ' + rest.slice((m.index ?? 0) + m[0].length))
    return m
  }

  // --- Assignee. Unicode-aware so a CJK name works as well as an ASCII one.
  const assigneeMatch = take(/@([^\s@]{1,64})/u)
  const assignee = assigneeMatch?.[1]

  // --- Date. Each form is tried once, most specific first.
  const base = new Date(now)
  base.setSeconds(0, 0)
  let day: Date | null = null

  const relativeDays = take(/(\d{1,3})\s*天(?:後|后)/u)
  const relativeHours = relativeDays ? null : take(/(\d{1,3})\s*(?:小時|小时)(?:後|后)?/u)
  if (relativeDays) {
    day = addDays(base, Number(relativeDays[1]))
  } else if (relativeHours) {
    // An hour offset names a moment, so it is complete on its own.
    const at = new Date(base.getTime() + Number(relativeHours[1]) * 3600_000)
    return finish(rest, assignee, at, null, matched)
  }

  if (!day) {
    const named = take(/(今天|今日|明天|明日|後天|后天|today|tomorrow)/iu)
    if (named) {
      const word = named[1].toLowerCase()
      const offset = /今/.test(word) || word === 'today' ? 0
        : /後|后/.test(word) ? 2
        : 1
      day = addDays(base, offset)
    }
  }

  if (!day) {
    const weekday = take(/(?:週|周|禮拜|礼拜|星期)([一二三四五六日])|\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/iu)
    if (weekday) {
      const key = (weekday[1] ?? weekday[2]).toLowerCase()
      day = nextWeekday(base, WEEKDAYS[key])
    }
  }

  if (!day) {
    // M/D, and only with a plausible day — 15/9 is not a date here.
    const slash = take(/\b(\d{1,2})\/(\d{1,2})\b/u)
    if (slash) {
      const month = Number(slash[1])
      const date = Number(slash[2])
      if (month >= 1 && month <= 12 && date >= 1 && date <= 31) {
        day = new Date(base)
        day.setMonth(month - 1, date)
        // A date that has already passed means next year, not the past.
        if (day.getTime() < base.getTime() - 86_400_000) day.setFullYear(day.getFullYear() + 1)
      } else {
        // Put it back: it was not a date after all.
        rest = restore(rest, slash[0], matched)
      }
    }
  }

  // --- Time of day. Deliberately not using \b: JavaScript's word class is
  // ASCII-only, so there is no boundary after 點, and `15點` would never match.
  // The lookaround does the same job for every script.
  //
  // The span is tried first. Matching the single-time pattern against
  // `14:00-15:00` would consume the start and leave `-15:00` stranded in the
  // text, which is precisely the silent damage this parser is not allowed to do.
  let hours: number | null = null
  let minutes = 0
  let endHours: number | null = null
  let endMinutes = 0

  const span = take(
    /(?<![\d/:])(\d{1,2})[:：點点](\d{2})?\s*[-–—~〜至到]\s*(\d{1,2})[:：點点](\d{2})?(?!\d)/u,
  )
  if (span) {
    const [h, m, h2, m2] = [Number(span[1]), part(span[2]), Number(span[3]), part(span[4])]
    if (h <= 23 && m <= 59 && h2 <= 23 && m2 <= 59) {
      hours = h
      minutes = m
      endHours = h2
      endMinutes = m2
    } else {
      rest = restore(rest, span[0], matched)
    }
  }

  if (hours === null) {
    const time = take(/(?<![\d/:])(\d{1,2})[:：點点](\d{2})?(?!\d)/u)
    if (time) {
      const h = Number(time[1])
      const m = part(time[2])
      if (h <= 23 && m <= 59) {
        hours = h
        minutes = m
      } else {
        rest = restore(rest, time[0], matched)
      }
    }
  }

  if (hours === null && !day) return finish(rest, assignee, null, null, matched)

  const at = new Date(day ?? base)
  if (hours === null) {
    at.setHours(END_OF_DAY.hours, END_OF_DAY.minutes, 0, 0)
  } else {
    at.setHours(hours, minutes, 0, 0)
    // A bare time that has already passed means the next one, not this morning.
    if (!day && at.getTime() < base.getTime()) at.setDate(at.getDate() + 1)
  }

  let end: Date | null = null
  if (endHours !== null) {
    end = new Date(at)
    end.setHours(endHours, endMinutes, 0, 0)
    // 23:00–01:00 is a real span across midnight, not a typo. Rolling it forward
    // also keeps the server's "an entry cannot end before it starts" happy.
    if (end.getTime() <= at.getTime()) end.setDate(end.getDate() + 1)
  }
  return finish(rest, assignee, at, end, matched)
}

/** An omitted minutes group means the hour exactly, not NaN. */
function part(value: string | undefined): number {
  return value === undefined ? 0 : Number(value)
}

function finish(rest: string, assignee: string | undefined, at: Date | null, end: Date | null,
  matched: string[]): Captured {
  return {
    text: rest.replace(/\s+/g, ' ').trim(),
    ...(assignee ? { assignee } : {}),
    ...(at ? { dueAt: at.toISOString() } : {}),
    ...(end ? { endAt: end.toISOString() } : {}),
    matched,
  }
}

function restore(rest: string, fragment: string, matched: string[]): string {
  matched.splice(matched.lastIndexOf(fragment.trim()), 1)
  return rest + ' ' + fragment
}

function addDays(from: Date, days: number): Date {
  const out = new Date(from)
  out.setDate(out.getDate() + days)
  return out
}

/** The coming occurrence of a weekday; naming today's weekday means next week. */
function nextWeekday(from: Date, weekday: number): Date {
  const out = new Date(from)
  const delta = (weekday - out.getDay() + 7) % 7 || 7
  out.setDate(out.getDate() + delta)
  return out
}

// --- Relative time -------------------------------------------------------

/**
 * How far off something is, in the words a room uses.
 *
 * A war room does arithmetic on "8/9 09:00"; it reads "3 小時後" directly.
 * Absolute timestamps are for the tooltip.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return iso

  const ms = then.getTime() - now.getTime()
  const overdue = ms < 0
  const abs = Math.abs(ms)
  const minutes = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)

  if (minutes < 1) return '現在'
  const amount =
    minutes < 60 ? `${minutes} 分鐘` : hours < 24 ? `${hours} 小時` : days < 30 ? `${days} 天` : null
  if (amount === null) return then.toLocaleDateString()
  return overdue ? `逾期 ${amount}` : `${amount}後`
}
