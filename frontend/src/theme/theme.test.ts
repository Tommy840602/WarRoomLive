import { describe, expect, it } from 'vitest'
import {
  DAY_FROM_HOUR,
  NIGHT_FROM_HOUR,
  msUntilNextSwitch,
  readPreference,
  resolveTheme,
  themeForHour,
} from './theme'

const at = (hour: number, minute = 0) => new Date(2026, 7, 5, hour, minute)

describe('resolveTheme', () => {
  it('follows the clock when left on auto', () => {
    expect(resolveTheme('auto', at(9), false)).toBe('day')
    expect(resolveTheme('auto', at(22), false)).toBe('night')
    expect(resolveTheme('auto', at(3), false)).toBe('night')
  })

  it('lets an explicit choice beat both the clock and the OS', () => {
    expect(resolveTheme('night', at(9), false)).toBe('night')
    expect(resolveTheme('day', at(23), true)).toBe('day')
  })

  it('lets a dark OS preference override the clock, but not a light one', () => {
    // Asymmetric on purpose: a browser reports "light" when the user has said
    // nothing, so it is not a statement. Dark is something someone turned on,
    // often for a reason as real as light sensitivity.
    expect(resolveTheme('auto', at(13), true)).toBe('night')
    expect(resolveTheme('auto', at(13), false)).toBe('day')
  })
})

describe('themeForHour', () => {
  it('switches at the boundaries and nowhere else', () => {
    expect(themeForHour(DAY_FROM_HOUR - 1)).toBe('night')
    expect(themeForHour(DAY_FROM_HOUR)).toBe('day')
    expect(themeForHour(NIGHT_FROM_HOUR - 1)).toBe('day')
    expect(themeForHour(NIGHT_FROM_HOUR)).toBe('night')
  })
})

describe('msUntilNextSwitch', () => {
  const hoursUntil = (from: Date) => msUntilNextSwitch(from) / 3_600_000

  it('aims at the next boundary rather than polling', () => {
    expect(hoursUntil(at(3))).toBeCloseTo(4)     // 03:00 → 07:00
    expect(hoursUntil(at(9))).toBeCloseTo(10)    // 09:00 → 19:00
    expect(hoursUntil(at(20))).toBeCloseTo(4)    // 20:00 → midnight, then re-evaluated
  })

  it('never returns zero, so a wake-up at the boundary cannot spin', () => {
    expect(msUntilNextSwitch(at(DAY_FROM_HOUR))).toBeGreaterThan(0)
    expect(msUntilNextSwitch(at(NIGHT_FROM_HOUR))).toBeGreaterThan(0)
  })
})

describe('readPreference', () => {
  const storage = (value: string | null) => ({ getItem: () => value })

  it('reads a stored choice', () => {
    expect(readPreference(storage('night'))).toBe('night')
  })

  it('falls back to auto for anything unrecognised', () => {
    expect(readPreference(storage(null))).toBe('auto')
    expect(readPreference(storage('purple'))).toBe('auto')
  })
})
