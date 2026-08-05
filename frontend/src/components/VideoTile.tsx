import { useEffect, useRef } from 'react'

interface VideoTileProps {
  label: string
  stream: MediaStream
  /** Mute local playback to avoid echo of your own microphone. */
  muted?: boolean
}

/** Renders a single participant's media stream. */
export function VideoTile({ label, stream, muted = false }: VideoTileProps) {
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
      <figcaption>{label}</figcaption>
    </figure>
  )
}
