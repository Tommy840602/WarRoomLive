// Shared shape of the signaling envelope. Mirrors the backend `SignalMessage` record;
// keep the two in sync when adding message types.

export type SignalType =
  | 'join'
  | 'leave'
  | 'offer'
  | 'answer'
  | 'candidate'
  | 'chat'
  | 'state'
  | 'reaction'
  | 'hand'
  | 'history'
  | 'peers'
  | 'peer-joined'
  | 'peer-left'
  | 'lock'
  | 'kick'
  | 'kicked'
  | 'room-state'
  | 'attachment'
  | 'room-full'
  | 'room-locked'
  | 'error'

/** Public identity of a peer, as carried in `peers` messages. */
export interface PeerInfo {
  id: string
  name: string
}

/** A peer's media on/off flags, carried in `state` messages (true = on). */
export interface MediaState {
  audio: boolean
  video: boolean
}

/**
 * The room's meta state, carried in `room-state` messages: the current host
 * (empty while the room is empty) and whether newcomers are locked out. Sent on
 * join and re-broadcast on every change (lock toggled, host handover).
 */
export interface RoomStateInfo {
  host: string
  locked: boolean
}

/**
 * A file shared into the room, carried in an `attachment` message when someone
 * uploads one and returned by `GET /api/attachments/{room}`. The bytes are never
 * here — a download URL is presigned on request.
 */
export interface Attachment {
  id: number
  room: string
  filename: string
  contentType: string
  sizeBytes: number
  uploadedBy: string
  uploadedAt: string
}

/** A persisted chat message, carried in the `history` message on join. */
export interface StoredMessage {
  fromId: string
  name: string
  text: string
  ts: number
}

export interface SignalMessage<TPayload = unknown> {
  type: SignalType
  room?: string
  /** Peer id of the sender (server-originated events) or omitted for client requests. */
  from?: string
  /** Target peer id for point-to-point relay (offer/answer/candidate). */
  to?: string
  payload?: TPayload
}
