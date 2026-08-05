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
  | 'peers'
  | 'peer-joined'
  | 'peer-left'
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

export interface SignalMessage<TPayload = unknown> {
  type: SignalType
  room?: string
  /** Peer id of the sender (server-originated events) or omitted for client requests. */
  from?: string
  /** Target peer id for point-to-point relay (offer/answer/candidate). */
  to?: string
  payload?: TPayload
}
