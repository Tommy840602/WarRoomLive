import { describe, expect, it } from 'vitest'
import {
  DEGRADE_AFTER_POOR_SAMPLES,
  QualityTracker,
  RESTORE_AFTER_GOOD_SAMPLES,
  classify,
  lossRatioBetween,
} from './quality'

const good = { lossRatio: 0, rttMs: 40 }
const poor = { lossRatio: 0.2, rttMs: 80 }

describe('classify', () => {
  it('calls a clean, fast link good', () => {
    expect(classify(good)).toBe('good')
  })

  it('grades on loss', () => {
    expect(classify({ lossRatio: 0.03, rttMs: 40 })).toBe('fair')
    expect(classify({ lossRatio: 0.09, rttMs: 40 })).toBe('poor')
  })

  it('grades on latency even when nothing is lost', () => {
    expect(classify({ lossRatio: 0, rttMs: 250 })).toBe('fair')
    expect(classify({ lossRatio: 0, rttMs: 600 })).toBe('poor')
  })

  it('takes the worse of the two signals', () => {
    expect(classify({ lossRatio: 0.09, rttMs: 10 })).toBe('poor')
    expect(classify({ lossRatio: 0, rttMs: 600 })).toBe('poor')
  })

  it('treats a missing RTT as no evidence rather than as bad', () => {
    expect(classify({ lossRatio: 0 })).toBe('good')
  })
})

describe('QualityTracker', () => {
  it('does not degrade on a single bad window', () => {
    const tracker = new QualityTracker()
    expect(tracker.record('bob', poor).degraded).toBe(false)
    expect(tracker.record('bob', good).degraded).toBe(false)
  })

  it('degrades only after sustained poor quality', () => {
    const tracker = new QualityTracker()
    for (let i = 1; i < DEGRADE_AFTER_POOR_SAMPLES; i++) {
      expect(tracker.record('bob', poor).degraded).toBe(false)
    }
    expect(tracker.record('bob', poor).degraded).toBe(true)
  })

  it('restores only after sustained recovery, and slower than it degraded', () => {
    const tracker = new QualityTracker()
    for (let i = 0; i < DEGRADE_AFTER_POOR_SAMPLES; i++) tracker.record('bob', poor)
    expect(tracker.get('bob')?.degraded).toBe(true)

    for (let i = 1; i < RESTORE_AFTER_GOOD_SAMPLES; i++) {
      expect(tracker.record('bob', good).degraded).toBe(true)
    }
    expect(tracker.record('bob', good).degraded).toBe(false)
    expect(RESTORE_AFTER_GOOD_SAMPLES).toBeGreaterThan(DEGRADE_AFTER_POOR_SAMPLES)
  })

  it('does not restore on a link that keeps flapping', () => {
    const tracker = new QualityTracker()
    for (let i = 0; i < DEGRADE_AFTER_POOR_SAMPLES; i++) tracker.record('bob', poor)
    for (let i = 0; i < 20; i++) {
      tracker.record('bob', good)
      tracker.record('bob', poor) // one bad window resets the recovery run
    }
    expect(tracker.get('bob')?.degraded).toBe(true)
  })

  it('tracks peers independently', () => {
    const tracker = new QualityTracker()
    for (let i = 0; i < DEGRADE_AFTER_POOR_SAMPLES; i++) {
      tracker.record('bob', poor)
      tracker.record('carol', good)
    }
    expect(tracker.get('bob')?.degraded).toBe(true)
    expect(tracker.get('carol')?.degraded).toBe(false)
  })

  it('forgets a peer that left', () => {
    const tracker = new QualityTracker()
    tracker.record('bob', poor)
    tracker.forget('bob')
    expect(tracker.get('bob')).toBeUndefined()
  })
})

describe('lossRatioBetween', () => {
  it('is zero for the first reading, with nothing to compare against', () => {
    expect(lossRatioBetween(undefined, { received: 500, lost: 50 })).toBe(0)
  })

  it('measures the window, not the whole session', () => {
    // 100 arrived and 10 were lost since the previous reading.
    const ratio = lossRatioBetween({ received: 900, lost: 90 }, { received: 1000, lost: 100 })
    expect(ratio).toBeCloseTo(10 / 110)
  })

  it('ignores counters that went backwards after a reconnect', () => {
    expect(lossRatioBetween({ received: 1000, lost: 100 }, { received: 5, lost: 0 })).toBe(0)
  })

  it('reports no loss when the window was silent', () => {
    expect(lossRatioBetween({ received: 100, lost: 1 }, { received: 100, lost: 1 })).toBe(0)
  })

  it('reports total loss when everything in the window was dropped', () => {
    expect(lossRatioBetween({ received: 100, lost: 0 }, { received: 100, lost: 50 })).toBe(1)
  })
})
