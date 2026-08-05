import { useCallback, useRef, useState } from 'react'
import { SignalingClient, defaultSignalingUrl } from './signaling/SignalingClient'
import { WebRtcRoom } from './webrtc/WebRtcRoom'
import { VideoTile } from './components/VideoTile'
import { ChatPanel } from './components/ChatPanel'
import { MemberList, type Member } from './components/MemberList'
import type { PeerInfo } from './signaling/types'
import './App.css'

type Status = 'idle' | 'connecting' | 'in-room' | 'error'

/** Chat message as stored locally; the sender's display name is resolved at render time. */
interface ChatEntry {
  id: string
  fromId: string
  text: string
  mine: boolean
}

export default function App() {
  const [room, setRoom] = useState('war-room')
  const [name, setName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [messages, setMessages] = useState<ChatEntry[]>([])
  const [screenSharing, setScreenSharing] = useState(false)

  const clientRef = useRef<SignalingClient | null>(null)
  const roomRef = useRef<WebRtcRoom | null>(null)
  const selfIdRef = useRef<string>(crypto.randomUUID())
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)

  /** Resolves a peer id to its display name, falling back to a short id. */
  const nameOf = (peerId: string) => names.get(peerId) ?? peerId.slice(0, 8)

  /** Everyone currently in the room, self first, for the member list. */
  const members: Member[] = [
    { id: selfIdRef.current, name: name.trim() || '你', isSelf: true },
    ...[...names].map(([id, memberName]) => ({ id, name: memberName, isSelf: false })),
  ]

  const join = useCallback(async () => {
    setStatus('connecting')
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      cameraStreamRef.current = stream
      setLocalStream(stream)

      const client = new SignalingClient(defaultSignalingUrl())
      await client.connect()
      clientRef.current = client

      // Track peer display names from room membership events. Registered before
      // join() so the initial `peers` reply is not missed.
      client.on('peers', (msg) =>
        setNames((prev) => {
          const next = new Map(prev)
          ;((msg.payload as PeerInfo[]) ?? []).forEach((p) => next.set(p.id, p.name))
          return next
        }),
      )
      client.on('peer-joined', (msg) => {
        if (msg.from) setNames((prev) => new Map(prev).set(msg.from!, String(msg.payload)))
      })
      client.on('peer-left', (msg) => {
        if (msg.from)
          setNames((prev) => {
            const next = new Map(prev)
            next.delete(msg.from!)
            return next
          })
      })

      // Chat rides the same signaling socket, independent of the WebRTC mesh.
      client.on('chat', (msg) =>
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            fromId: msg.from ?? 'unknown',
            text: String(msg.payload),
            mine: false,
          },
        ]),
      )

      const webRtcRoom = new WebRtcRoom(client, selfIdRef.current, stream, {
        onRemoteStream: (peerId, remote) =>
          setRemoteStreams((prev) => new Map(prev).set(peerId, remote)),
        onPeerLeft: (peerId) =>
          setRemoteStreams((prev) => {
            const next = new Map(prev)
            next.delete(peerId)
            return next
          }),
        onError: (reason) => setError(reason),
      })
      roomRef.current = webRtcRoom
      const displayName = name.trim() || `訪客-${selfIdRef.current.slice(0, 4)}`
      webRtcRoom.join(room, displayName)
      setStatus('in-room')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [room, name])

  const leave = useCallback(() => {
    roomRef.current?.leave(room)
    clientRef.current?.close()
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    roomRef.current = null
    clientRef.current = null
    cameraStreamRef.current = null
    screenStreamRef.current = null
    setLocalStream(null)
    setRemoteStreams(new Map())
    setNames(new Map())
    setMessages([])
    setScreenSharing(false)
    setStatus('idle')
  }, [room])

  const stopScreenShare = useCallback(() => {
    const camera = cameraStreamRef.current
    if (roomRef.current && camera?.getVideoTracks()[0]) {
      void roomRef.current.replaceVideoTrack(camera.getVideoTracks()[0])
    }
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current = null
    setLocalStream(camera)
    setScreenSharing(false)
  }, [])

  const startScreenShare = useCallback(async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true })
      const screenTrack = screen.getVideoTracks()[0]
      if (!screenTrack || !roomRef.current) return
      await roomRef.current.replaceVideoTrack(screenTrack)
      screenStreamRef.current = screen
      setLocalStream(screen)
      setScreenSharing(true)
      // The browser's own "stop sharing" control ends the track — revert when it does.
      screenTrack.onended = () => stopScreenShare()
    } catch (e) {
      // getDisplayMedia rejects if the user cancels the picker; that is not an error.
      if (e instanceof DOMException && e.name === 'NotAllowedError') return
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [stopScreenShare])

  const sendChat = useCallback(
    (text: string) => {
      clientRef.current?.send({ type: 'chat', room, from: selfIdRef.current, payload: text })
      // The server broadcasts only to others, so echo our own message locally.
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), fromId: selfIdRef.current, text, mine: true },
      ])
    },
    [room],
  )

  return (
    <main className="app">
      <header className="app__header">
        <h1>WarRoomLive</h1>
        <p className="app__subtitle">低延遲跨部門協作討論室</p>
      </header>

      <section className="app__controls">
        <label>
          你的名稱
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="輸入顯示名稱"
            disabled={status === 'in-room' || status === 'connecting'}
          />
        </label>
        <label>
          房間名稱
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={status === 'in-room' || status === 'connecting'}
          />
        </label>
        {status === 'in-room' ? (
          <>
            <button
              className="btn-secondary"
              onClick={screenSharing ? stopScreenShare : startScreenShare}
            >
              {screenSharing ? '停止分享' : '分享螢幕'}
            </button>
            <button onClick={leave}>離開房間</button>
          </>
        ) : (
          <button onClick={join} disabled={status === 'connecting' || !room.trim()}>
            {status === 'connecting' ? '連線中…' : '加入房間'}
          </button>
        )}
      </section>

      {error && <p className="app__error">⚠️ {error}</p>}

      <section className="workspace">
        <div className="video-grid">
          {localStream && (
            <VideoTile
              label={`${name.trim() || '你'}(你${screenSharing ? '・分享中' : ''})`}
              stream={localStream}
              muted
            />
          )}
          {[...remoteStreams].map(([peerId, stream]) => (
            <VideoTile key={peerId} label={nameOf(peerId)} stream={stream} />
          ))}
        </div>
        <div className="sidebar">
          {status === 'in-room' && <MemberList members={members} />}
          <ChatPanel
            messages={messages.map((m) => ({
              id: m.id,
              from: m.mine ? '你' : nameOf(m.fromId),
              text: m.text,
              mine: m.mine,
            }))}
            onSend={sendChat}
            disabled={status !== 'in-room'}
          />
        </div>
      </section>
    </main>
  )
}
