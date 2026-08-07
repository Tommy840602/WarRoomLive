import type { SignalMessage, SignalType } from './types'

type Listener = (message: SignalMessage) => void

/** What the UI shows about the transport. `reconnecting` means traffic is being dropped. */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SignalingClientOptions {
  /** Called on every transition, for the connection banner. */
  onStateChange?: (state: ConnectionState) => void
  /**
   * Called after a reconnect re-opens the socket — never after the first
   * connect. The room is gone from the server's point of view by then, so this
   * is where the app re-joins and replays its state.
   */
  onReconnected?: () => void
}

/** Backoff schedule, capped; jitter keeps a restarted server from being stampeded. */
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 10_000

/**
 * Wrapper around the signaling WebSocket that survives a dropped connection.
 *
 * A laptop sleeping, a Wi-Fi switch or a backend restart closes the socket. The
 * CRDT plane heals itself, so without this the notes keep syncing while the
 * user is silently no longer in the room — the most confusing possible state.
 * Reconnection is transport-level only: re-joining the room and replaying local
 * state is the app's job, driven by {@link SignalingClientOptions.onReconnected}.
 *
 * Two closes must never be retried, because retrying defeats a server decision:
 * a kick (4403) and a deliberate {@link close}. An expired token (4401) *is*
 * retried — the URL is rebuilt per attempt, so a renewed token is picked up.
 */
export class SignalingClient {
  private socket?: WebSocket
  private readonly listeners = new Map<SignalType, Set<Listener>>()
  private state: ConnectionState = 'closed'
  private attempt = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private closedByUs = false
  /** Distinguishes the first connect from a recovery, so re-join only fires on the latter. */
  private everConnected = false

  /**
   * @param url the socket URL, or a function returning it — a function is
   *   re-evaluated per attempt, which is how a renewed token reaches the server.
   */
  constructor(
    private readonly url: string | (() => string),
    private readonly options: SignalingClientOptions = {},
  ) {}

  connect(): Promise<void> {
    this.closedByUs = false
    return new Promise((resolve, reject) => {
      this.open(
        () => resolve(),
        () => reject(new Error(`WebSocket failed to connect: ${this.currentUrl()}`)),
      )
    })
  }

  /** Registers a handler for a message type. Returns an unsubscribe function. */
  on(type: SignalType, listener: Listener): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
    return () => set.delete(listener)
  }

  /**
   * Sends a message if the socket is open. While reconnecting the message is
   * dropped rather than queued: signaling traffic is about *now* (offers,
   * presence, typing), and replaying a stale burst on recovery would be worse
   * than losing it. Callers that must not lose data check {@link isOpen}.
   */
  send(message: SignalMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      console.warn(`Dropping '${message.type}': signaling socket is ${this.state}`)
      return
    }
    this.socket.send(JSON.stringify(message))
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  /** Deliberate teardown: cancels any pending retry and stops reconnecting. */
  close(): void {
    this.closedByUs = true
    clearTimeout(this.retryTimer)
    this.socket?.close()
    this.socket = undefined
    this.listeners.clear()
    this.setState('closed')
  }

  // --- internals ----------------------------------------------------------

  private currentUrl(): string {
    return typeof this.url === 'function' ? this.url() : this.url
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    this.options.onStateChange?.(next)
  }

  private open(onOpen?: () => void, onFirstError?: () => void): void {
    this.setState(this.everConnected ? 'reconnecting' : 'connecting')
    const socket = new WebSocket(this.currentUrl())
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.setState('open')
      const recovered = this.everConnected
      this.everConnected = true
      onOpen?.()
      // The server dropped our membership when the old socket died, so the app
      // has to re-announce itself before anything else can work.
      if (recovered) this.options.onReconnected?.()
    }
    socket.onmessage = (event) => this.dispatch(event.data)
    socket.onerror = () => {
      // Only the very first attempt rejects connect(); later failures are
      // handled by the retry loop via onclose, which always follows.
      if (!this.everConnected) onFirstError?.()
    }
    socket.onclose = (event) => this.onClose(event)
  }

  private onClose(event: CloseEvent): void {
    if (this.closedByUs || !this.everConnected) {
      this.setState('closed')
      return
    }
    if (event.code === 4403) {
      // Removed by the host: reconnecting would be re-entering a room we were
      // just told to leave.
      this.setState('closed')
      return
    }
    this.setState('reconnecting')
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempt, RETRY_MAX_MS)
    this.attempt++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.open(), delay * (0.5 + Math.random() / 2))
  }

  private dispatch(raw: string): void {
    let message: SignalMessage
    try {
      message = JSON.parse(raw) as SignalMessage
    } catch {
      console.warn('Ignoring unparseable signaling frame', raw)
      return
    }
    this.listeners.get(message.type)?.forEach((listener) => listener(message))
  }
}

/**
 * Resolves the signaling URL from the current page origin (works behind the Vite
 * proxy). Browsers cannot set headers on WebSocket handshakes, so when OIDC is
 * active the bearer token rides as an `access_token` query parameter (RFC 6750).
 */
export function defaultSignalingUrl(token?: string | null): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const base = `${scheme}://${window.location.host}/ws/signal`
  return token ? `${base}?access_token=${encodeURIComponent(token)}` : base
}
