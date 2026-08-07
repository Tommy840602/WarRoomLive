/**
 * Connection quality for the mesh transport.
 *
 * The judgement is deliberately separated from the WebRTC plumbing: reading
 * `getStats()` needs a live browser, but deciding what a reading *means* — and
 * when to act on it — is arithmetic, so it lives in pure functions that can be
 * tested properly. {@link sampleConnection} is the only part that touches the
 * peer connection.
 */

export type QualityLevel = 'good' | 'fair' | 'poor'

/** A reading over one sampling window, as seen by the receiving side. */
export interface QualitySample {
  /** Round-trip time in milliseconds, from the nominated candidate pair. */
  rttMs?: number
  /** Fraction of packets lost in this window, 0–1. */
  lossRatio: number
  /** Inter-arrival jitter in milliseconds. */
  jitterMs?: number
}

// Thresholds for interactive audio/video. Loss hurts sooner than latency does,
// so it is what mainly drives the verdict.
const POOR_LOSS = 0.05
const FAIR_LOSS = 0.02
const POOR_RTT_MS = 400
const FAIR_RTT_MS = 200

export function classify(sample: QualitySample): QualityLevel {
  if (sample.lossRatio >= POOR_LOSS || (sample.rttMs ?? 0) >= POOR_RTT_MS) return 'poor'
  if (sample.lossRatio >= FAIR_LOSS || (sample.rttMs ?? 0) >= FAIR_RTT_MS) return 'fair'
  return 'good'
}

/**
 * Turns a stream of readings into a stable verdict and a degrade/restore
 * decision, per peer.
 *
 * Both directions need hysteresis, for opposite reasons: a single bad window
 * (a passing burst of loss) must not drop everyone's video, and a single good
 * window must not immediately undo a degradation on a link that is still
 * flapping. Restoring is deliberately slower than degrading — degrading is
 * cheap and recoverable, thrashing resolution is what users actually notice.
 */
export const DEGRADE_AFTER_POOR_SAMPLES = 3
export const RESTORE_AFTER_GOOD_SAMPLES = 6

export interface PeerQuality {
  level: QualityLevel
  /** True while outgoing video to this peer should be held back. */
  degraded: boolean
  lastSample: QualitySample
}

export class QualityTracker {
  private readonly state = new Map<string, {
    poorRun: number
    goodRun: number
    quality: PeerQuality
  }>()

  /**
   * Records a reading and returns the peer's current verdict, or null when the
   * sample carried nothing usable (a connection that has not sent traffic yet).
   */
  record(peerId: string, sample: QualitySample): PeerQuality {
    const level = classify(sample)
    const entry = this.state.get(peerId) ?? {
      poorRun: 0,
      goodRun: 0,
      quality: { level, degraded: false, lastSample: sample },
    }

    entry.poorRun = level === 'poor' ? entry.poorRun + 1 : 0
    entry.goodRun = level === 'good' ? entry.goodRun + 1 : 0

    let degraded = entry.quality.degraded
    if (!degraded && entry.poorRun >= DEGRADE_AFTER_POOR_SAMPLES) degraded = true
    else if (degraded && entry.goodRun >= RESTORE_AFTER_GOOD_SAMPLES) degraded = false

    entry.quality = { level, degraded, lastSample: sample }
    this.state.set(peerId, entry)
    return entry.quality
  }

  get(peerId: string): PeerQuality | undefined {
    return this.state.get(peerId)?.quality
  }

  forget(peerId: string): void {
    this.state.delete(peerId)
  }

  clear(): void {
    this.state.clear()
  }
}

/**
 * Difference between two cumulative counter readings, guarding the cases that
 * make naive subtraction produce nonsense: a counter that reset (reconnect) and
 * a window in which nothing arrived.
 */
export function lossRatioBetween(
  previous: { received: number; lost: number } | undefined,
  current: { received: number; lost: number },
): number {
  if (!previous || current.received < previous.received || current.lost < previous.lost) {
    // First reading, or the counters restarted — no meaningful window yet.
    return 0
  }
  const received = current.received - previous.received
  const lost = current.lost - previous.lost
  const total = received + lost
  return total > 0 ? lost / total : 0
}

/** Cumulative counters pulled from one peer connection, for windowing. */
export interface RtpCounters {
  received: number
  lost: number
}

/**
 * Reads one peer connection's inbound RTP and the nominated candidate pair.
 * Returns the sample plus the raw counters, which the caller keeps to compute
 * the next window.
 */
export async function sampleConnection(
  pc: RTCPeerConnection,
  previous?: RtpCounters,
): Promise<{ sample: QualitySample; counters: RtpCounters }> {
  const stats = await pc.getStats()
  const counters: RtpCounters = { received: 0, lost: 0 }
  let jitterMs: number | undefined
  let rttMs: number | undefined

  stats.forEach((report) => {
    if (report.type === 'inbound-rtp') {
      counters.received += report.packetsReceived ?? 0
      counters.lost += Math.max(report.packetsLost ?? 0, 0)
      if (report.jitter != null) {
        jitterMs = Math.max(jitterMs ?? 0, report.jitter * 1000)
      }
    }
    // Only the pair actually carrying media describes the path in use.
    if (report.type === 'candidate-pair' && report.nominated && report.currentRoundTripTime != null) {
      rttMs = report.currentRoundTripTime * 1000
    }
  })

  return {
    sample: { rttMs, jitterMs, lossRatio: lossRatioBetween(previous, counters) },
    counters,
  }
}
