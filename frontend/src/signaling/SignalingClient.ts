import type { SignalMessage, SignalType } from './types'

type Listener = (message: SignalMessage) => void

/**
 * Thin, reconnect-free wrapper around the signaling WebSocket.
 *
 * Responsibilities are deliberately narrow: connect, send typed envelopes, and fan
 * inbound messages out to type-keyed listeners. Reconnection and room orchestration
 * live one layer up (see {@link ../webrtc/WebRtcRoom}).
 */
export class SignalingClient {
  private socket?: WebSocket
  private readonly listeners = new Map<SignalType, Set<Listener>>()

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.socket = socket
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error(`WebSocket failed to connect: ${this.url}`))
      socket.onmessage = (event) => this.dispatch(event.data)
    })
  }

  /** Registers a handler for a message type. Returns an unsubscribe function. */
  on(type: SignalType, listener: Listener): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
    return () => set.delete(listener)
  }

  send(message: SignalMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send: signaling socket is not open')
    }
    this.socket.send(JSON.stringify(message))
  }

  close(): void {
    this.socket?.close()
    this.socket = undefined
    this.listeners.clear()
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
