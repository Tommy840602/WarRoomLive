import { useCallback, useRef, useState } from 'react'
import { SignalingClient, defaultSignalingUrl } from './signaling/SignalingClient'
import { WebRtcRoom } from './webrtc/WebRtcRoom'
import { VideoTile } from './components/VideoTile'
import './App.css'

type Status = 'idle' | 'connecting' | 'in-room' | 'error'

export default function App() {
  const [room, setRoom] = useState('war-room')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())

  const clientRef = useRef<SignalingClient | null>(null)
  const roomRef = useRef<WebRtcRoom | null>(null)
  const selfIdRef = useRef<string>(crypto.randomUUID())

  const join = useCallback(async () => {
    setStatus('connecting')
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setLocalStream(stream)

      const client = new SignalingClient(defaultSignalingUrl())
      await client.connect()
      clientRef.current = client

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
      webRtcRoom.join(room)
      setStatus('in-room')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [room])

  const leave = useCallback(() => {
    roomRef.current?.leave(room)
    clientRef.current?.close()
    localStream?.getTracks().forEach((track) => track.stop())
    roomRef.current = null
    clientRef.current = null
    setLocalStream(null)
    setRemoteStreams(new Map())
    setStatus('idle')
  }, [room, localStream])

  return (
    <main className="app">
      <header className="app__header">
        <h1>WarRoomLive</h1>
        <p className="app__subtitle">低延遲跨部門協作討論室</p>
      </header>

      <section className="app__controls">
        <label>
          房間名稱
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={status === 'in-room' || status === 'connecting'}
          />
        </label>
        {status === 'in-room' ? (
          <button onClick={leave}>離開房間</button>
        ) : (
          <button onClick={join} disabled={status === 'connecting' || !room.trim()}>
            {status === 'connecting' ? '連線中…' : '加入房間'}
          </button>
        )}
      </section>

      {error && <p className="app__error">⚠️ {error}</p>}

      <section className="video-grid">
        {localStream && <VideoTile label="你" stream={localStream} muted />}
        {[...remoteStreams].map(([peerId, stream]) => (
          <VideoTile key={peerId} label={peerId.slice(0, 8)} stream={stream} />
        ))}
      </section>
    </main>
  )
}
