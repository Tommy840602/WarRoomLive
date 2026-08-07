import { SignalingClient } from '../signaling/SignalingClient'
import type { PeerInfo, SignalMessage } from '../signaling/types'

export interface WebRtcRoomEvents {
  /** A remote peer's media stream became available (or was replaced). */
  onRemoteStream: (peerId: string, stream: MediaStream) => void
  /** A remote peer left; the UI should drop its tile. */
  onPeerLeft: (peerId: string) => void
  /** Non-fatal signaling error surfaced by the server. */
  onError?: (reason: string) => void
}

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

    this.signaling.send({ type: 'join', room, from: this.selfId, payload: displayName })
  }

  leave(room: string): void {
    this.signaling.send({ type: 'leave', room, from: this.selfId })
    this.peers.forEach((pc) => pc.close())
    this.peers.clear()
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

    this.peers.set(peerId, pc)
    return pc
  }
}
