import { useEffect, useRef } from 'react'

interface VideoTileProps {
  label: string
  stream: MediaStream
  /** Mute local playback to avoid echo of your own microphone. */
  muted?: boolean
  /** Show a mic-off badge when this participant's audio is disabled. */
  audioOff?: boolean
  /** Overlay a placeholder when this participant's video is disabled. */
  videoOff?: boolean
  /** Show a raised-hand badge. */
  handRaised?: boolean
}

/** Renders a single participant's media stream with mic/camera status. */
export function VideoTile({
  label,
  stream,
  muted = false,
  audioOff = false,
  videoOff = false,
  handRaised = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (el && el.srcObject !== stream) {
      el.srcObject = stream
    }
  }, [stream])

  return (
    <figure className="video-tile">
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {handRaised && <span className="video-tile__hand" aria-label="舉手">✋</span>}
      {videoOff && (
        <div className="video-tile__off">
          <span className="video-tile__off-avatar">{[...label.trim()][0]?.toUpperCase() ?? '?'}</span>
        </div>
      )}
      <figcaption>
        {audioOff && <span className="video-tile__mute" aria-label="靜音">🔇</span>}
        {label}
      </figcaption>
    </figure>
  )
}
