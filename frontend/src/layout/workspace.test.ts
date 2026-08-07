import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  TILE_STEPS,
  clampSidebar,
  clampTile,
  readNumber,
  stepTile,
  writeNumber,
} from './workspace'

describe('clampSidebar', () => {
  it('keeps the panel between its bounds', () => {
    expect(clampSidebar(10)).toBe(SIDEBAR_MIN)
    expect(clampSidebar(5000)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(500)).toBe(500)
  })

  it('never takes so much that the video column has nothing left', () => {
    // Dragging past the edge would leave the divider off screen and the layout
    // unrecoverable without clearing storage.
    expect(clampSidebar(900, 700)).toBe(SIDEBAR_MIN + (700 - SIDEBAR_MIN - SIDEBAR_MIN))
    expect(clampSidebar(900, 700)).toBeLessThanOrEqual(700 - SIDEBAR_MIN)
  })

  it('still yields a usable panel on a screen too small for both', () => {
    // The minimum wins over the "leave room for video" rule: a 40px panel is
    // worse than a cramped video area.
    expect(clampSidebar(400, 300)).toBe(SIDEBAR_MIN)
  })

  it('returns whole pixels', () => {
    expect(clampSidebar(400.6)).toBe(401)
  })
})

describe('clampTile', () => {
  it('snaps to an offered size', () => {
    expect(TILE_STEPS).toContain(clampTile(250))
    expect(clampTile(238)).toBe(240)
  })

  it('cannot be wedged by a value from outside the app', () => {
    // A hand-edited or stale localStorage entry must still land on a step, or
    // the stepper has no index to move from.
    expect(TILE_STEPS).toContain(clampTile(-5))
    expect(TILE_STEPS).toContain(clampTile(99999))
  })
})

describe('stepTile', () => {
  it('moves one step at a time', () => {
    expect(stepTile(TILE_STEPS[1], 1)).toBe(TILE_STEPS[2])
    expect(stepTile(TILE_STEPS[1], -1)).toBe(TILE_STEPS[0])
  })

  it('stops at the ends rather than wrapping round', () => {
    expect(stepTile(TILE_STEPS[0], -1)).toBe(TILE_STEPS[0])
    expect(stepTile(TILE_STEPS[TILE_STEPS.length - 1], 1)).toBe(TILE_STEPS[TILE_STEPS.length - 1])
  })

  it('steps from the nearest size when the current one is not on the scale', () => {
    expect(TILE_STEPS).toContain(stepTile(237, 1))
  })
})

describe('readNumber', () => {
  const store = (value: string | null) => ({ getItem: () => value })

  it('reads a stored number', () => {
    expect(readNumber(store('420'), 'k', 320)).toBe(420)
  })

  it('falls back when nothing is stored', () => {
    expect(readNumber(store(null), 'k', 320)).toBe(320)
  })

  it('falls back on anything unusable rather than propagating NaN', () => {
    // NaN would flow into a CSS length and collapse the layout silently.
    expect(readNumber(store('wide'), 'k', 320)).toBe(320)
    expect(readNumber(store(''), 'k', 320)).toBe(320)
    expect(readNumber(store('Infinity'), 'k', 320)).toBe(320)
  })

  it('survives storage that refuses to be read', () => {
    const refusing = { getItem: () => { throw new Error('denied') } }
    expect(readNumber(refusing, 'k', 320)).toBe(320)
  })
})

describe('writeNumber', () => {
  it('stores the value as a string', () => {
    const written: Record<string, string> = {}
    writeNumber({ setItem: (k, v) => { written[k] = v } }, 'k', 420)
    expect(written.k).toBe('420')
  })

  it('survives storage that refuses to be written', () => {
    // Private browsing throws on write; the choice still holds for the session.
    expect(() =>
      writeNumber({ setItem: () => { throw new Error('quota') } }, 'k', 420),
    ).not.toThrow()
  })
})
