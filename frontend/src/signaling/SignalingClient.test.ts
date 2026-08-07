import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignalingClient, defaultSignalingUrl } from './SignalingClient'

/**
 * Drop-in WebSocket the tests drive by hand. Every instance is recorded so a
 * test can assert how many connection attempts were made and with what URL.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  readonly sent: string[] = []
  closedByClient = false

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closedByClient = true
    this.readyState = FakeWebSocket.CLOSED
  }

  // --- test drivers ---
  accept(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

describe('SignalingClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Connects a client and settles the opening handshake. */
  async function connected(url: string | (() => string) = 'ws://test/ws/signal', options = {}) {
    const client = new SignalingClient(url, options)
    const opening = client.connect()
    latest().accept()
    await opening
    return client
  }

  it('reports connecting then open, and resolves connect()', async () => {
    const states: string[] = []
    await connected('ws://test/ws/signal', { onStateChange: (s: string) => states.push(s) })
    expect(states).toEqual(['connecting', 'open'])
  })

  it('rejects connect() when the very first attempt fails', async () => {
    const client = new SignalingClient('ws://test/ws/signal')
    const opening = client.connect()
    latest().onerror?.()
    await expect(opening).rejects.toThrow(/failed to connect/)
  })

  it('retries an unexpected drop and re-announces via onReconnected', async () => {
    const onReconnected = vi.fn()
    await connected('ws://test/ws/signal', { onReconnected })
    expect(onReconnected).not.toHaveBeenCalled() // never for the first connect

    latest().drop()
    expect(FakeWebSocket.instances).toHaveLength(1) // waits out the backoff first

    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    latest().accept()
    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('backs off further on each failed attempt', async () => {
    await connected()
    latest().drop()

    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    latest().drop()

    // The second wait is longer than the first, so a short tick is not enough.
    await vi.advanceTimersByTimeAsync(400)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('never reconnects after a kick (4403)', async () => {
    const onReconnected = vi.fn()
    const states: string[] = []
    await connected('ws://test/ws/signal', {
      onReconnected,
      onStateChange: (s: string) => states.push(s),
    })

    latest().drop(4403)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onReconnected).not.toHaveBeenCalled()
    expect(states[states.length - 1]).toBe('closed')
  })

  it('never reconnects after a deliberate close', async () => {
    const client = await connected()
    client.close()
    latest().drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('re-reads the URL on every attempt, so a renewed token is used', async () => {
    let token = 'old'
    await connected(() => `ws://test/ws/signal?access_token=${token}`)
    expect(latest().url).toContain('old')

    token = 'renewed'
    latest().drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(latest().url).toContain('renewed')
  })

  it('keeps listeners across a reconnect', async () => {
    const client = await connected()
    const chat = vi.fn()
    client.on('chat', chat)

    latest().deliver({ type: 'chat', payload: 'before' })
    latest().drop()
    await vi.advanceTimersByTimeAsync(1000)
    latest().accept()
    latest().deliver({ type: 'chat', payload: 'after' })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1][0].payload).toBe('after')
  })

  it('drops sends while the socket is down instead of throwing', async () => {
    const client = await connected()
    const socket = latest()
    socket.drop()

    expect(() => client.send({ type: 'chat', payload: 'lost' })).not.toThrow()
    expect(socket.sent).toHaveLength(0)
    expect(client.isOpen).toBe(false)
  })

  it('ignores unparseable frames rather than killing the connection', async () => {
    const client = await connected()
    const chat = vi.fn()
    client.on('chat', chat)

    latest().onmessage?.({ data: 'not json' })
    latest().deliver({ type: 'chat', payload: 'still working' })

    expect(chat).toHaveBeenCalledTimes(1)
  })
})

describe('defaultSignalingUrl', () => {
  it('derives the socket URL from the page origin', () => {
    expect(defaultSignalingUrl()).toBe(`ws://${window.location.host}/ws/signal`)
  })

  it('carries the token as a query parameter, encoded', () => {
    expect(defaultSignalingUrl('a b+c')).toBe(
      `ws://${window.location.host}/ws/signal?access_token=a%20b%2Bc`,
    )
  })
})
