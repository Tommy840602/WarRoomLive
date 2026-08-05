// Shared shape of the signaling envelope. Mirrors the backend `SignalMessage` record;
// keep the two in sync when adding message types.

export type SignalType =
  | 'join'
  | 'leave'
  | 'offer'
  | 'answer'
  | 'candidate'
  | 'peers'
  | 'peer-joined'
  | 'peer-left'
  | 'error'

export interface SignalMessage<TPayload = unknown> {
  type: SignalType
  room?: string
  /** Peer id of the sender (server-originated events) or omitted for client requests. */
  from?: string
  /** Target peer id for point-to-point relay (offer/answer/candidate). */
  to?: string
  payload?: TPayload
}
