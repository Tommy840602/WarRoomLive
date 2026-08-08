import { useEffect, useRef, useState } from 'react'
import { createRecognizer, speechRecognitionSupported } from './speech'

interface Options {
  /** Whether the local participant wants to be captioned. */
  enabled: boolean
  /** BCP-47 tag to recognize in, e.g. `cmn-Hant-TW` or `en-US`. */
  lang: string
  /** Called for every guess and every settled sentence. */
  onChunk: (chunk: { text: string; final: boolean }) => void
}

/**
 * Runs the local recognizer while captions are switched on.
 *
 * <p>The handler is held in a ref rather than listed as a dependency. It closes
 * over the room, the socket and the speaker's identity, so it is a new function
 * on almost every render — as a dependency it would tear down and rebuild the
 * recognizer several times a second, which in practice means recognition never
 * runs long enough to finish a sentence.
 *
 * <p>Changing language <em>does</em> rebuild it, because that is the one thing
 * a running recognizer cannot be told.
 */
export function useSpeechCaptions({ enabled, lang, onChunk }: Options) {
  const [error, setError] = useState<string | null>(null)
  const handler = useRef(onChunk)
  handler.current = onChunk

  useEffect(() => {
    if (!enabled) {
      setError(null)
      return
    }
    // Cleared on each start: a permission error the user has since fixed should
    // not still be on screen after they switch captions back on.
    setError(null)
    const recognizer = createRecognizer(lang, {
      onChunk: (chunk) => handler.current(chunk),
      onStopped: setError,
    })
    if (!recognizer) {
      setError('這個瀏覽器不支援語音辨識')
      return
    }
    return () => recognizer.stop()
  }, [enabled, lang])

  return { error, supported: speechRecognitionSupported() }
}
