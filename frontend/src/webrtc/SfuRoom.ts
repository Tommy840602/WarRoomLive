import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
} from 'livekit-client'
import { SignalingClient } from '../signaling/SignalingClient'
import type { WebRtcRoomEvents } from './WebRtcRoom'

/** The surface App needs from a media session; WebRtcRoom satisfies it structurally. */
export interface MediaRoom {
  join(room: string, displayName: string): void
  leave(room: string): void
  replaceVideoTrack(track: MediaStreamTrack): Promise<void>
  /** The signaling socket dropped and recovered; re-establish media if needed. */
  handleReconnect(): void
}

/**
 * SFU media session backed by LiveKit. Replaces the full-mesh transport when the
 * backend advertises SFU mode: each participant uploads once to the SFU, which
 * fans out — upload cost stops scaling with room size.
 *
 * Only media moves here. Room membership, names, chat, reactions and media-state
 * flags keep flowing over the signaling WebSocket exactly as in mesh mode, so the
 * rest of the app is transport-agnostic. LiveKit participant identity is the same
 * `selfId` used on the signaling plane, which lets remote tracks map back onto the
 * existing peer-keyed UI state.
 */
export class SfuRoom implements MediaRoom {
  // adaptiveStream: subscribed video resolution follows the rendered tile size;
  // dynacast: the SFU pauses simulcast layers nobody is subscribed to.
  private readonly room = new Room({ adaptiveStream: true, dynacast: true })
  /** One synthetic MediaStream per remote identity, feeding the existing VideoTile UI. */
  private readonly remoteStreams = new Map<string, MediaStream>()

  constructor(
    private readonly signaling: SignalingClient,
    private readonly selfId: string,
    private readonly localStream: MediaStream,
    private readonly events: WebRtcRoomEvents,
    private readonly livekit: { url: string; token: string },
  ) {}

  join(roomName: string, displayName: string): void {
    // Same signaling join as mesh mode: drives membership, names, chat, history.
    this.signaling.on('error', (msg) => this.events.onError?.(String(msg.payload)))
    this.signaling.send({ type: 'join', room: roomName, from: this.selfId, payload: displayName })

    void this.connectMedia()
  }

  private async connectMedia(): Promise<void> {
    try {
      this.room
        .on(RoomEvent.TrackSubscribed, (track, _pub, participant) =>
          this.onTrackSubscribed(track, participant),
        )
        .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
          this.remoteStreams.get(participant.identity)?.removeTrack(track.mediaStreamTrack)
        })
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          this.remoteStreams.delete(participant.identity)
          this.events.onPeerLeft(participant.identity)
        })
        // The SFU already judges each participant's link; map its verdict onto
        // the same shape the mesh path computes, so the UI has one language.
        .on(RoomEvent.ConnectionQualityChanged, (quality, participant) =>
          this.onQualityChanged(quality, participant),
        )

      await this.room.connect(this.livekit.url, this.livekit.token)

      const audio = this.localStream.getAudioTracks()[0]
      const video = this.localStream.getVideoTracks()[0]
      if (audio) await this.room.localParticipant.publishTrack(audio, { source: Track.Source.Microphone })
      if (video) {
        await this.room.localParticipant.publishTrack(video, {
          source: Track.Source.Camera,
          simulcast: true, // multiple encodings; receivers pick per bandwidth
        })
      }
    } catch (e) {
      this.events.onError?.(`SFU 連線失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private onQualityChanged(quality: ConnectionQuality, participant: Participant): void {
    const level = quality === ConnectionQuality.Excellent || quality === ConnectionQuality.Good
      ? 'good'
      : quality === ConnectionQuality.Poor
        ? 'poor'
        : 'fair'
    // No degradation to apply here: adaptiveStream and dynacast already adjust
    // what the SFU sends, which is the whole point of publishing once.
    this.events.onQuality?.(participant.identity, {
      level,
      degraded: false,
      lastSample: { lossRatio: 0 },
    })
  }

  private onTrackSubscribed(track: RemoteTrack, participant: RemoteParticipant): void {
    let stream = this.remoteStreams.get(participant.identity)
    if (!stream) {
      stream = new MediaStream()
      this.remoteStreams.set(participant.identity, stream)
    }
    stream.addTrack(track.mediaStreamTrack)
    this.events.onRemoteStream(participant.identity, stream)
  }

  /** Camera ↔ screen share swap: republish through the existing camera publication. */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    const publication = this.room.localParticipant.getTrackPublication(Track.Source.Camera)
    const localTrack = publication?.videoTrack
    if (localTrack) {
      await localTrack.replaceTrack(track, { userProvidedTrack: true })
    } else {
      await this.room.localParticipant.publishTrack(track, { source: Track.Source.Camera })
    }
  }

  /**
   * Nothing to do: media here rides LiveKit's own connection, which has its own
   * reconnection and is unaffected by the signaling socket dropping. Tearing
   * down tracks on a signaling blip would cause a visible outage for no reason.
   */
  handleReconnect(): void {}

  leave(roomName: string): void {
    this.signaling.send({ type: 'leave', room: roomName, from: this.selfId })
    void this.room.disconnect()
    this.remoteStreams.clear()
  }
}

/** Media-plane bootstrap served by the backend. */
export interface MediaConfig {
  /** What THIS room is on right now. Changes are announced in `room-state`. */
  mode: 'sfu' | 'mesh'
  /**
   * Whether an SFU is deployed at all, which is a different question.
   *
   * Without it the UI cannot tell "a small room, on the mesh by design" from
   * "no SFU here, so this room is on its own past the limit" — and only the
   * second one is worth warning anybody about.
   */
  sfuAvailable?: boolean
  /** Participants past which a room moves to the SFU. */
  meshMaxPeers?: number
  livekitUrl: string
  /** STUN/TURN servers for mesh-mode RTCPeerConnections (TURN when configured). */
  iceServers?: RTCIceServer[]
}

const authHeaders = (token?: string | null): HeadersInit =>
  token ? { Authorization: `Bearer ${token}` } : {}

/**
 * Asks the backend which media transport this room is on.
 *
 * Room-scoped, because the answer is: a room that has already outgrown the mesh
 * puts its next joiner straight onto the SFU rather than having them negotiate a
 * mesh they are about to be moved off.
 *
 * Absent or legacy backends mean mesh, which is also what an unreachable one
 * means — it is the mode that needs nothing beyond the browser.
 */
export async function fetchMediaConfig(
  token?: string | null,
  room?: string,
): Promise<MediaConfig> {
  try {
    const query = room ? `?room=${encodeURIComponent(room)}` : ''
    const res = await fetch(`/api/media/config${query}`, { headers: authHeaders(token) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as MediaConfig
  } catch {
    return { mode: 'mesh', livekitUrl: '' }
  }
}

/** Fetches a room-scoped LiveKit access token from the backend. */
export async function fetchMediaToken(
  room: string,
  identity: string,
  name: string,
  token?: string | null,
): Promise<string> {
  const params = new URLSearchParams({ room, identity, name })
  const res = await fetch(`/api/media/token?${params}`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`無法取得 SFU token(HTTP ${res.status})`)
  return ((await res.json()) as { token: string }).token
}

/** Resolves the SFU URL: path-style values (behind the nginx proxy) resolve against the page origin. */
export function resolveLivekitUrl(configured: string): string {
  if (configured.startsWith('/')) {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${window.location.host}${configured}`
  }
  return configured
}
