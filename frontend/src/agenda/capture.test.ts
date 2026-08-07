import { describe, expect, it } from 'vitest'
import { parseCapture, relativeTime } from './capture'

// A fixed Wednesday afternoon, so weekday and rollover cases are stable.
const NOW = new Date(2026, 7, 5, 14, 30, 0) // 2026-08-05 14:30 local, a Wednesday

const at = (input: string) => parseCapture(input, NOW)
const local = (iso: string) => new Date(iso)

describe('parseCapture', () => {
  it('keeps a plain line entirely as text', () => {
    const out = at('訂會議室')
    expect(out.text).toBe('訂會議室')
    expect(out.assignee).toBeUndefined()
    expect(out.dueAt).toBeUndefined()
  })

  it('lifts an assignee out of the middle without eating the words around it', () => {
    const out = at('請 @bob 寄簡報')
    expect(out.assignee).toBe('bob')
    expect(out.text).toBe('請 寄簡報')
  })

  it('accepts a CJK name', () => {
    expect(at('寄簡報 @小明').assignee).toBe('小明')
  })

  it('reads a day and a time together', () => {
    const out = at('寄簡報 @bob 明天15:00')
    expect(out.text).toBe('寄簡報')
    expect(out.assignee).toBe('bob')
    const due = local(out.dueAt!)
    expect(due.getDate()).toBe(6)
    expect(due.getHours()).toBe(15)
    expect(due.getMinutes()).toBe(0)
  })

  it('treats a day with no time as due by the end of that day', () => {
    // "due tomorrow" means by the end of tomorrow, not 9am sharp.
    const due = local(at('交報告 明天').dueAt!)
    expect(due.getDate()).toBe(6)
    expect(due.getHours()).toBe(23)
    expect(due.getMinutes()).toBe(59)
  })

  it('rolls a bare time that has already passed to the next one', () => {
    // 09:00 said at 14:30 means tomorrow morning, not this morning.
    const due = local(at('站會 9:00').dueAt!)
    expect(due.getDate()).toBe(6)
    expect(due.getHours()).toBe(9)
  })

  it('keeps a bare time that is still ahead on today', () => {
    const due = local(at('站會 16:00').dueAt!)
    expect(due.getDate()).toBe(5)
    expect(due.getHours()).toBe(16)
  })

  it('understands 點 as a time', () => {
    expect(local(at('開會 15點').dueAt!).getHours()).toBe(15)
  })

  it('reads the coming weekday, and never today', () => {
    // Said on a Wednesday, "週三" is next Wednesday — there is no point
    // scheduling something for a day that is already half gone.
    expect(local(at('回顧 週三').dueAt!).getDate()).toBe(12)
    expect(local(at('回顧 週五').dueAt!).getDate()).toBe(7)
  })

  it('reads relative days and hours', () => {
    expect(local(at('追進度 3天後').dueAt!).getDate()).toBe(8)
    const inTwo = local(at('回電 2小時後').dueAt!)
    expect(inTwo.getHours()).toBe(16)
    expect(inTwo.getMinutes()).toBe(30)
  })

  it('reads M/D and rolls a past date into next year', () => {
    expect(local(at('結算 8/20').dueAt!).getMonth()).toBe(7)
    expect(local(at('結算 1/5').dueAt!).getFullYear()).toBe(2027)
  })

  it('leaves an impossible date in the text rather than inventing one', () => {
    // 15/9 is not a date; swallowing it would lose part of what was typed.
    const out = at('規格 15/9')
    expect(out.dueAt).toBeUndefined()
    expect(out.text).toContain('15/9')
  })

  it('leaves an impossible time in the text', () => {
    const out = at('版本 99:99')
    expect(out.dueAt).toBeUndefined()
    expect(out.text).toContain('99:99')
  })

  it('never loses text it did not recognise', () => {
    // The property that matters: everything typed is either a parsed field or
    // still in the text. Nothing may vanish.
    for (const input of ['買咖啡', '買咖啡 @a', '買咖啡 明天', '15/9 @a 3天後 x']) {
      const out = at(input)
      const consumed = out.matched.join(' ')
      const kept = `${out.text} ${out.assignee ?? ''} ${consumed}`
      for (const word of input.split(/\s+/).filter(Boolean)) {
        const bare = word.replace(/^@/, '')
        expect(kept).toContain(bare)
      }
    }
  })
})

describe('relativeTime', () => {
  const t = (ms: number) => relativeTime(new Date(NOW.getTime() + ms).toISOString(), NOW)

  it('reads forwards and backwards in the words a room uses', () => {
    expect(t(3 * 3_600_000)).toBe('3 小時後')
    expect(t(-2 * 86_400_000)).toBe('逾期 2 天')
    expect(t(45 * 60_000)).toBe('45 分鐘後')
  })

  it('calls the current minute now rather than "0 分鐘後"', () => {
    expect(t(10_000)).toBe('現在')
  })

  it('falls back to a date once relative stops being useful', () => {
    expect(t(200 * 86_400_000)).not.toContain('後')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(relativeTime('nonsense', NOW)).toBe('nonsense')
  })
})

describe('parseCapture spans', () => {
  it('reads a span as a start and an end', () => {
    const out = at('與法務對齊 明天14:00-15:00')
    expect(out.text).toBe('與法務對齊')
    expect(local(out.dueAt!).getHours()).toBe(14)
    expect(local(out.endAt!).getHours()).toBe(15)
  })

  it('does not strand the second half of a span in the text', () => {
    // The single-time pattern would eat `14:00` and leave `-15:00` behind,
    // which is exactly the silent damage this parser must never do.
    expect(at('週會 14:00-15:00').text).toBe('週會')
  })

  it('accepts the dashes and tildes people actually type', () => {
    for (const line of ['週會 14:00–15:00', '週會 14:00~15:00', '週會 14:00 - 15:00',
      '週會 14:00至15:00', '週會 14點-15點']) {
      const out = at(line)
      expect(out.endAt, line).toBeDefined()
      expect(out.text, line).toBe('週會')
    }
  })

  it('rolls an end before the start over midnight rather than inverting it', () => {
    // 23:00–01:00 is a real span, and an inverted one is refused by the server.
    const out = at('值班 23:00-01:00')
    expect(new Date(out.endAt!).getTime()).toBeGreaterThan(new Date(out.dueAt!).getTime())
    expect(local(out.endAt!).getHours()).toBe(1)
  })

  it('leaves an impossible span in the text', () => {
    const out = at('週會 14:00-99:00')
    expect(out.text).toContain('99:00')
    expect(out.endAt).toBeUndefined()
  })

  it('gives a plain time no end at all', () => {
    expect(at('寄簡報 明天15:00').endAt).toBeUndefined()
  })
})
