import { useCallback, useRef, useState } from 'react'
import { SignalingClient, defaultSignalingUrl } from './signaling/SignalingClient'
import { WebRtcRoom } from './webrtc/WebRtcRoom'
import { VideoTile } from './components/VideoTile'
import { ChatPanel } from './components/ChatPanel'
import { CollabNotes } from './components/CollabNotes'
import { MemberList, type Member } from './components/MemberList'
import { ReactionBar } from './components/ReactionBar'
import { FloatingReactions, type FloatingReaction } from './components/FloatingReactions'
import type { MediaState, PeerInfo, StoredMessage } from './signaling/types'
import { useAuth } from './auth/AuthGate'
import './App.css'

type Status = 'idle' | 'connecting' | 'in-room' | 'error'

// The mesh topology degrades as peers multiply; warn before the hard cap (backend: 8).
const ROOM_WARN_THRESHOLD = 6

/** Chat message as stored locally; the sender's display name is resolved at render time. */
interface ChatEntry {
  id: string
  fromId: string
  text: string
  mine: boolean
  /** For replayed history: the sender's name as recorded, since they may have left. */
  name?: string
}

export default function App() {
  const { token, displayName: authName } = useAuth()
  const [room, setRoom] = useState('war-room')
  // With OIDC active the identity provider supplies the name; it stays editable.
  const [name, setName] = useState(authName ?? '')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [messages, setMessages] = useState<ChatEntry[]>([])
  const [screenSharing, setScreenSharing] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [peerStates, setPeerStates] = useState<Map<string, MediaState>>(new Map())
  const [handRaised, setHandRaised] = useState(false)
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set())
  const [reactions, setReactions] = useState<FloatingReaction[]>([])

  const clientRef = useRef<SignalingClient | null>(null)
  const roomRef = useRef<WebRtcRoom | null>(null)
  const selfIdRef = useRef<string>(crypto.randomUUID())
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  // Mirror the flags so listeners registered once can read the latest values.
  const mediaStateRef = useRef<MediaState>({ audio: true, video: true })
  const handRaisedRef = useRef(false)

  /** Resolves a peer id to its display name, falling back to a short id. */
  const nameOf = (peerId: string) => names.get(peerId) ?? peerId.slice(0, 8)

  /** Adds a floating emoji that removes itself after the animation. */
  const showReaction = useCallback((emoji: string) => {
    const id = crypto.randomUUID()
    const left = 10 + Math.floor(parseInt(id.slice(0, 8), 16) % 80)
    setReactions((prev) => [...prev, { id, emoji, left }])
    setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 3000)
  }, [])

  /** Everyone currently in the room, self first, for the member list. */
  const members: Member[] = [
    {
      id: selfIdRef.current,
      name: name.trim() || '你',
      isSelf: true,
      audioOff: !audioEnabled,
      videoOff: !videoEnabled,
      handRaised,
    },
    ...[...names].map(([id, memberName]) => ({
      id,
      name: memberName,
      isSelf: false,
      audioOff: peerStates.get(id)?.audio === false,
      videoOff: peerStates.get(id)?.video === false,
      handRaised: raisedHands.has(id),
    })),
  ]

  /** Tears down the session and resets all room state (does not notify the server). */
  const teardown = useCallback(() => {
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
    setPeerStates(new Map())
    setMessages([])
    setScreenSharing(false)
    setAudioEnabled(true)
    setVideoEnabled(true)
    setHandRaised(false)
    setRaisedHands(new Set())
    setReactions([])
    mediaStateRef.current = { audio: true, video: true }
    handRaisedRef.current = false
    setStatus('idle')
  }, [])

  const join = useCallback(async () => {
    setStatus('connecting')
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      cameraStreamRef.current = stream
      setLocalStream(stream)

      const client = new SignalingClient(defaultSignalingUrl(token))
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
        if (!msg.from) return
        setNames((prev) => new Map(prev).set(msg.from!, String(msg.payload)))
        // Re-announce our current media state and raised-hand status to the newcomer.
        client.send({ type: 'state', room, from: selfIdRef.current, payload: mediaStateRef.current })
        if (handRaisedRef.current) {
          client.send({ type: 'hand', room, from: selfIdRef.current, payload: true })
        }
      })
      client.on('peer-left', (msg) => {
        if (!msg.from) return
        setNames((prev) => {
          const next = new Map(prev)
          next.delete(msg.from!)
          return next
        })
        setPeerStates((prev) => {
          const next = new Map(prev)
          next.delete(msg.from!)
          return next
        })
        setRaisedHands((prev) => {
          const next = new Set(prev)
          next.delete(msg.from!)
          return next
        })
      })
      client.on('state', (msg) => {
        if (msg.from) setPeerStates((prev) => new Map(prev).set(msg.from!, msg.payload as MediaState))
      })
      client.on('room-full', (msg) => {
        teardown()
        setError(`房間已滿(上限 ${msg.payload} 人),請換一個房間或稍後再試`)
      })
      client.on('reaction', (msg) => showReaction(String(msg.payload)))
      client.on('hand', (msg) => {
        if (!msg.from) return
        setRaisedHands((prev) => {
          const next = new Set(prev)
          if (msg.payload) next.add(msg.from!)
          else next.delete(msg.from!)
          return next
        })
      })

      // On join the server replays the room's recent chat history.
      client.on('history', (msg) => {
        const stored = (msg.payload as StoredMessage[]) ?? []
        setMessages(
          stored.map((m) => ({
            id: crypto.randomUUID(),
            fromId: m.fromId,
            text: m.text,
            mine: m.fromId === selfIdRef.current,
            name: m.name,
          })),
        )
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
  }, [room, name, token, teardown, showReaction])

  const leave = useCallback(() => {
    roomRef.current?.leave(room)
    teardown()
  }, [room, teardown])

  /** Broadcasts our latest media on/off flags to the room. */
  const broadcastState = useCallback(
    (next: MediaState) => {
      mediaStateRef.current = next
      clientRef.current?.send({ type: 'state', room, from: selfIdRef.current, payload: next })
    },
    [room],
  )

  const toggleAudio = useCallback(() => {
    const track = cameraStreamRef.current?.getAudioTracks()[0]
    const next = !audioEnabled
    if (track) track.enabled = next
    setAudioEnabled(next)
    broadcastState({ audio: next, video: videoEnabled })
  }, [audioEnabled, videoEnabled, broadcastState])

  const toggleVideo = useCallback(() => {
    // Apply to whichever video is currently being sent (camera or screen share).
    const track =
      screenStreamRef.current?.getVideoTracks()[0] ?? cameraStreamRef.current?.getVideoTracks()[0]
    const next = !videoEnabled
    if (track) track.enabled = next
    setVideoEnabled(next)
    broadcastState({ audio: audioEnabled, video: next })
  }, [audioEnabled, videoEnabled, broadcastState])

  const sendReaction = useCallback(
    (emoji: string) => {
      clientRef.current?.send({ type: 'reaction', room, from: selfIdRef.current, payload: emoji })
      showReaction(emoji) // show our own reaction locally too
    },
    [room, showReaction],
  )

  const toggleHand = useCallback(() => {
    const next = !handRaised
    setHandRaised(next)
    handRaisedRef.current = next
    clientRef.current?.send({ type: 'hand', room, from: selfIdRef.current, payload: next })
  }, [handRaised, room])

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
            <button className="btn-secondary" onClick={toggleAudio}>
              {audioEnabled ? '靜音' : '取消靜音'}
            </button>
            <button className="btn-secondary" onClick={toggleVideo}>
              {videoEnabled ? '關閉視訊' : '開啟視訊'}
            </button>
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

      {status === 'in-room' && members.length >= ROOM_WARN_THRESHOLD && (
        <p className="app__warning">
          ⚠️ 房間目前 {members.length} 人。此版本採 WebRTC full mesh,人數偏多時上行頻寬與畫面可能開始卡頓(上限 8 人)。
        </p>
      )}

      {status === 'in-room' && (
        <ReactionBar onReact={sendReaction} handRaised={handRaised} onToggleHand={toggleHand} />
      )}

      <section className="workspace">
        <div className="video-grid">
          {localStream && (
            <VideoTile
              label={`${name.trim() || '你'}(你${screenSharing ? '・分享中' : ''})`}
              stream={localStream}
              muted
              audioOff={!audioEnabled}
              videoOff={!videoEnabled && !screenSharing}
              handRaised={handRaised}
            />
          )}
          {[...remoteStreams].map(([peerId, stream]) => (
            <VideoTile
              key={peerId}
              label={nameOf(peerId)}
              stream={stream}
              audioOff={peerStates.get(peerId)?.audio === false}
              videoOff={peerStates.get(peerId)?.video === false}
              handRaised={raisedHands.has(peerId)}
            />
          ))}
        </div>
        <div className="sidebar">
          {status === 'in-room' && <MemberList members={members} />}
          <ChatPanel
            messages={messages.map((m) => ({
              id: m.id,
              from: m.mine ? '你' : m.name ?? nameOf(m.fromId),
              text: m.text,
              mine: m.mine,
            }))}
            onSend={sendChat}
            disabled={status !== 'in-room'}
          />
        </div>
      </section>

      {status === 'in-room' && (
        <CollabNotes
          room={room}
          userName={name.trim() || `訪客-${selfIdRef.current.slice(0, 4)}`}
          token={token}
        />
      )}

      <FloatingReactions reactions={reactions} />
    </main>
  )
}
