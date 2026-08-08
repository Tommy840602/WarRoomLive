/**
 * The browser's own speech recognition, as much of it as is safe to rely on.
 *
 * <p>Recognition happens in the browser rather than on the server, and that is a
 * deliberate architectural choice rather than the easy one. Sending audio to the
 * server for transcription would double every participant's upload — the media
 * plane is already carrying that audio to the other people in the room — and put
 * a second real-time pipeline next to the one that already exists. The browser
 * has the microphone open; it can do this itself.
 *
 * <p>The cost is honest: this is a Chrome-family API. Firefox and Safari do not
 * implement it, so those browsers can read subtitles but cannot produce them.
 * That is why {@link speechRecognitionSupported} exists and why the UI asks
 * before offering the control — an offer that silently does nothing is worse
 * than no offer.
 */

/** Minimal shape of the vendor API; the DOM lib does not declare it. */
interface SpeechRecognitionAlternative {
  transcript: string
}
interface SpeechRecognitionResult {
  isFinal: boolean
  0: SpeechRecognitionAlternative
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResult }
}
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function ctor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechRecognitionSupported(): boolean {
  return ctor() !== null
}

export interface RecognizedChunk {
  text: string
  final: boolean
}

export interface RecognizerHandlers {
  onChunk: (chunk: RecognizedChunk) => void
  /** Fatal, in the sense that captions have stopped and the UI should say so. */
  onStopped: (reason: string) => void
}

/**
 * A recognizer that keeps itself alive.
 *
 * <p>`continuous` is a promise the implementation does not keep: recognition
 * ends on its own after a pause, after a network hiccup, and on some builds
 * every minute or so regardless. A caption track that stopped the first time
 * somebody paused to think would be useless, so `onend` restarts it — but only
 * while the caller still wants it running, or stopping would be impossible.
 *
 * <p>`no-speech` and `aborted` are not failures. They are what silence and a
 * deliberate stop look like coming out of this API, and treating them as errors
 * would put "captions failed" on screen every time a room went quiet.
 */
export function createRecognizer(lang: string, handlers: RecognizerHandlers) {
  const Ctor = ctor()
  if (!Ctor) return null

  let wanted = true
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  const recognition = new Ctor()
  recognition.lang = lang
  recognition.continuous = true
  recognition.interimResults = true
  // One guess. Alternatives cost nothing to receive and are never shown — the
  // subtitle can only hold one sentence, and it is always the first.
  recognition.maxAlternatives = 1

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0]?.transcript ?? ''
      if (text.trim()) handlers.onChunk({ text: text.trim(), final: result.isFinal })
    }
  }

  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return
    // Permission is the one the user can actually do something about, so it is
    // the one worth naming rather than folding into a generic failure.
    wanted = false
    handlers.onStopped(
      event.error === 'not-allowed' ? '沒有麥克風權限' : `語音辨識中斷(${event.error})`,
    )
  }

  recognition.onend = () => {
    if (!wanted) return
    // A beat before restarting. Immediately re-calling start() on a recognizer
    // that just ended throws on some builds, and a tight restart loop against a
    // failing service is indistinguishable from a spin.
    restartTimer = setTimeout(() => {
      try {
        recognition.start()
      } catch {
        // Already running: the previous start won the race. Nothing to do.
      }
    }, 300)
  }

  try {
    recognition.start()
  } catch {
    return null
  }

  return {
    stop() {
      wanted = false
      if (restartTimer) clearTimeout(restartTimer)
      try {
        recognition.abort()
      } catch {
        // Already dead. The only thing that matters is that it stays that way.
      }
    },
  }
}
