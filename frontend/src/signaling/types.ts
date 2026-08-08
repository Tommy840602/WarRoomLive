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
  | 'agenda'
  | 'agenda-due'
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

/** One item on the room's shared to-do list. */
export interface Todo {
  id: number
  room: string
  text: string
  done: boolean
  assignee?: string
  /** ISO-8601 instant. */
  dueAt?: string
  createdBy: string
  createdAt: string
  completedAt?: string
  completedBy?: string
  /**
   * The room's stored triage decision, absent while the clock is still
   * deciding. Absent and `NOW` are different states, so this is optional rather
   * than defaulted — see `agenda/item.ts`.
   */
  triage?: 'NOW' | 'LATER'
}

/** One entry on the room's shared calendar. Times are ISO-8601 instants. */
export interface CalendarEvent {
  id: number
  room: string
  title: string
  description: string
  startsAt: string
  endsAt?: string
  /** Free text, like a to-do's: an appointment can belong to somebody. */
  assignee?: string
  createdBy: string
  createdAt: string
  /** Entries can be marked dealt with, exactly as to-do items can. */
  done?: boolean
  completedAt?: string
  completedBy?: string
  triage?: 'NOW' | 'LATER'
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

/** One occupancy episode of a room, as the history panel reads it. */
export interface Meeting {
  id: number
  room: string
  startedAt: string
  endedAt?: string
  participantPeak: number
  durationSeconds?: number
  /** Present and true while the room is still occupied — the duration is not a fact yet. */
  live?: boolean
}

/** Payload of an `agenda-due` message: this specific thing's time has arrived. */
export interface AgendaDue {
  kind: 'todo' | 'calendar'
  id: number
  text: string
  dueAt: string
  assignee?: string
}
