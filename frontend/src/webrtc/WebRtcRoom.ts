import { SignalingClient } from '../signaling/SignalingClient'
import type { PeerInfo, SignalMessage } from '../signaling/types'
import {
  QualityTracker,
  sampleConnection,
  type PeerQuality,
  type RtpCounters,
} from './quality'

export interface WebRtcRoomEvents {
  /** A remote peer's media stream became available (or was replaced). */
  onRemoteStream: (peerId: string, stream: MediaStream) => void
  /** A remote peer left; the UI should drop its tile. */
  onPeerLeft: (peerId: string) => void
  /** Non-fatal signaling error surfaced by the server. */
  onError?: (reason: string) => void
  /** Periodic per-peer link quality, for the connection indicator. */
  onQuality?: (peerId: string, quality: PeerQuality) => void
}

/** How often each link is measured. */
const QUALITY_INTERVAL_MS = 2000
/** Ceiling applied to outgoing video for a peer whose link is struggling. */
const DEGRADED_MAX_BITRATE = 150_000
const DEGRADED_SCALE_DOWN = 2

/**
 * Full-mesh WebRTC session for one room.
 *
 * Each participant holds a direct {@link RTCPeerConnection} to every other participant.
 * Mesh is simple and lowest-latency for small groups; beyond ~6–8 participants an SFU
 * should replace this. The "polite peer" tie-break to avoid glare is intentionally
 * simple here: the peer that was already in the room initiates the offer to the newcomer.
 */
export class WebRtcRoom {
  private readonly peers = new Map<string, RTCPeerConnection>()
  private readonly quality = new QualityTracker()
  /** Previous cumulative RTP counters per peer, so loss is measured per window. */
  private readonly counters = new Map<string, RtpCounters>()
  private qualityTimer?: ReturnType<typeof setInterval>
  private room = ''

  /** The original camera video track — kept so screen sharing can be reverted. */
  readonly cameraVideoTrack: MediaStreamTrack | null

  /** The video track currently sent to peers (camera or screen). */
  private activeVideoTrack: MediaStreamTrack | null

  constructor(
    private readonly signaling: SignalingClient,
    private readonly selfId: string,
    private readonly localStream: MediaStream,
    private readonly events: WebRtcRoomEvents,
    private readonly iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }],
  ) {
    this.cameraVideoTrack = localStream.getVideoTracks()[0] ?? null
    this.activeVideoTrack = this.cameraVideoTrack
  }

  /**
   * Swaps the outgoing video track on every peer connection without renegotiation
   * (e.g. camera → screen share and back). New peers that join afterwards receive
   * whatever track is active at that time.
   */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    this.activeVideoTrack = track
    await Promise.all(
      [...this.peers.values()].map((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        return sender ? sender.replaceTrack(track) : Promise.resolve()
      }),
    )
  }

  /** Wires up signaling handlers and announces our arrival in the room under {@code displayName}. */
  join(room: string, displayName: string): void {
    this.signaling.on('peers', (msg) => this.onExistingPeers(room, msg))
    this.signaling.on('peer-joined', (msg) => this.onPeerJoined(room, msg))
    this.signaling.on('peer-left', (msg) => this.onPeerLeft(msg))
    this.signaling.on('offer', (msg) => this.onOffer(room, msg))
    this.signaling.on('answer', (msg) => this.onAnswer(msg))
    this.signaling.on('candidate', (msg) => this.onCandidate(msg))
    this.signaling.on('error', (msg) => this.events.onError?.(String(msg.payload)))

    this.room = room
    this.signaling.send({ type: 'join', room, from: this.selfId, payload: displayName })
    this.qualityTimer ??= setInterval(() => void this.measure(), QUALITY_INTERVAL_MS)
  }

  leave(room: string): void {
    this.signaling.send({ type: 'leave', room, from: this.selfId })
    clearInterval(this.qualityTimer)
    this.qualityTimer = undefined
    this.peers.forEach((pc) => pc.close())
    this.peers.clear()
    this.quality.clear()
    this.counters.clear()
  }

  /**
   * Measures every link and adjusts what we send on it. Degradation is applied
   * per peer, not globally: one participant on hotel Wi-Fi should not cost
   * everyone else their video quality.
   */
  private async measure(): Promise<void> {
    for (const [peerId, pc] of this.peers) {
      if (pc.connectionState !== 'connected') continue
      const { sample, counters } = await sampleConnection(pc, this.counters.get(peerId))
      this.counters.set(peerId, counters)
      const before = this.quality.get(peerId)?.degraded ?? false
      const quality = this.quality.record(peerId, sample)
      this.events.onQuality?.(peerId, quality)
      if (quality.degraded !== before) {
        await this.applyVideoLimit(pc, quality.degraded)
      }
    }
  }

  /** Caps (or releases) the outgoing video encoding for one peer connection. */
  private async applyVideoLimit(pc: RTCPeerConnection, degraded: boolean): Promise<void> {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    if (!sender) return
    const parameters = sender.getParameters()
    // Firefox hands back parameters without encodings until the first setParameters.
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
    for (const encoding of parameters.encodings) {
      if (degraded) {
        encoding.maxBitrate = DEGRADED_MAX_BITRATE
        encoding.scaleResolutionDownBy = DEGRADED_SCALE_DOWN
      } else {
        delete encoding.maxBitrate
        delete encoding.scaleResolutionDownBy
      }
    }
    try {
      await sender.setParameters(parameters)
    } catch (e) {
      console.warn('Could not adjust outgoing video quality', e)
    }
  }

  /**
   * Re-negotiates ICE for a connection the browser gave up on — a network
   * change (Wi-Fi to cellular) invalidates the candidates without the peers
   * going anywhere. Only one side may restart, or the two offers collide:
   * the lower peer id does it, an arbitrary but stable tie-break.
   */
  private async restartIce(peerId: string, pc: RTCPeerConnection): Promise<void> {
    if (this.selfId > peerId) return
    try {
      const offer = await pc.createOffer({ iceRestart: true })
      await pc.setLocalDescription(offer)
      this.signaling.send({
        type: 'offer', room: this.room, from: this.selfId, to: peerId, payload: offer,
      })
    } catch (e) {
      console.warn(`ICE restart for ${peerId} failed`, e)
    }
  }

  /**
   * The signaling socket dropped and came back. Every peer connection is stale:
   * while we were away the others were told we left and closed their side, so
   * ours can never recover. Tear them all down — the `peers` reply to the
   * re-join then makes us the newcomer again and we re-offer to everyone,
   * which is the same asymmetry a first join uses.
   */
  handleReconnect(): void {
    this.peers.forEach((pc, peerId) => {
      pc.close()
      this.events.onPeerLeft(peerId)
    })
    this.peers.clear()
    this.quality.clear()
    this.counters.clear()
  }

  // --- signaling handlers ---------------------------------------------------

  private async onExistingPeers(room: string, msg: SignalMessage): Promise<void> {
    const peers = (msg.payload as PeerInfo[]) ?? []
    // We are the newcomer: initiate an offer to everyone already here.
    for (const { id: peerId } of peers) {
      const pc = this.createPeer(room, peerId)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.signaling.send({ type: 'offer', room, from: this.selfId, to: peerId, payload: offer })
    }
  }

  private onPeerJoined(room: string, msg: SignalMessage): void {
    // A newcomer joined; they will send us an offer, so just pre-create the connection.
    if (msg.from) this.createPeer(room, msg.from)
  }

  private onPeerLeft(msg: SignalMessage): void {
    const peerId = msg.from
    if (!peerId) return
    this.peers.get(peerId)?.close()
    this.peers.delete(peerId)
    this.quality.forget(peerId)
    this.counters.delete(peerId)
    this.events.onPeerLeft(peerId)
  }

  private async onOffer(room: string, msg: SignalMessage): Promise<void> {
    if (!msg.from) return
    const pc = this.createPeer(room, msg.from)
    await pc.setRemoteDescription(new RTCSessionDescription(msg.payload as RTCSessionDescriptionInit))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.signaling.send({ type: 'answer', room, from: this.selfId, to: msg.from, payload: answer })
  }

  private async onAnswer(msg: SignalMessage): Promise<void> {
    const pc = msg.from ? this.peers.get(msg.from) : undefined
    if (!pc) return
    await pc.setRemoteDescription(new RTCSessionDescription(msg.payload as RTCSessionDescriptionInit))
  }

  private async onCandidate(msg: SignalMessage): Promise<void> {
    const pc = msg.from ? this.peers.get(msg.from) : undefined
    if (!pc || !msg.payload) return
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.payload as RTCIceCandidateInit))
    } catch (e) {
      console.warn('Failed to add ICE candidate', e)
    }
  }

  // --- peer connection factory ---------------------------------------------

  private createPeer(room: string, peerId: string): RTCPeerConnection {
    const existing = this.peers.get(peerId)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    // Audio always comes from the mic; video is whatever is currently active
    // (camera or an in-progress screen share).
    this.localStream.getAudioTracks().forEach((track) => pc.addTrack(track, this.localStream))
    if (this.activeVideoTrack) {
      pc.addTrack(this.activeVideoTrack, this.localStream)
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'candidate',
          room,
          from: this.selfId,
          to: peerId,
          payload: event.candidate.toJSON(),
        })
      }
    }
    pc.ontrack = (event) => {
      const [stream] = event.streams
      if (stream) this.events.onRemoteStream(peerId, stream)
    }
    pc.onconnectionstatechange = () => {
      // 'failed' is not the peer leaving — the signaling plane would have said
      // so. It usually means the path died under us (a network change), which
      // fresh candidates can recover without anyone rejoining.
      if (pc.connectionState === 'failed') {
        void this.restartIce(peerId, pc)
      }
    }

    this.peers.set(peerId, pc)
    return pc
  }
}
