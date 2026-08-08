/**
 * What is on screen as a subtitle, and for how long.
 *
 * Pure and separate from the component, because none of this is rendering. A
 * subtitle track has to hold several ideas at once — one live line per speaker,
 * finished lines that linger and then go, translations that arrive after the
 * line they belong to, and the speaker's own line which they rendered locally
 * before the server had ever heard of it — and every one of those is a way to
 * end up with the same sentence on screen twice.
 */

/** How long a finished line stays up after it settles. Long enough to read. */
export const HOLD_MS = 6000

/**
 * How long an unfinished line survives without an update.
 *
 * Recognition sometimes stops mid-sentence — the speaker mutes, the tab is
 * backgrounded, the service drops — and leaves its last guess behind. Without
 * this, half a sentence stays on screen for the rest of the meeting.
 */
export const STALE_MS = 12000

/**
 * At most this many at once.
 *
 * Three is what fits above the video without becoming the video. In a busy room
 * more lines arrive than can be read anyway, and the useful ones are the newest.
 */
export const MAX_VISIBLE = 3

export interface SubtitleLine {
  /** The server's id, once the line is durable. Absent on an interim guess. */
  id?: number
  peerId: string
  speaker: string
  text: string
  /** BCP-47, as the recognizer reported it. */
  lang: string
  translation?: string
  translationLang?: string
  /** False while recognition is still revising this sentence. */
  final: boolean
  /** When this version of the line arrived, by the local clock. */
  at: number
}

export interface IncomingCaption {
  id?: number
  peerId: string
  speaker: string
  text: string
  lang: string
  final: boolean
}

/**
 * Folds one caption into the track.
 *
 * <p>Three merges, in order of how easy they are to get wrong:
 *
 * 1. An interim replaces that peer's previous interim. A speaker has exactly one
 *    unfinished sentence at a time, and appending each revision would print the
 *    sentence being typed one letter at a time.
 * 2. A final replaces that peer's interim rather than following it. The interim
 *    *was* this sentence, in draft.
 * 3. A final that carries an id merges into a matching final that has none. That
 *    is the speaker's own line coming back from the server: they rendered it the
 *    moment they said it, and the echo exists only to hand over the id the
 *    translation will be keyed by. Appending it would show every speaker their
 *    own words twice.
 */
export function applyCaption(
  lines: SubtitleLine[],
  incoming: IncomingCaption,
  now: number,
): SubtitleLine[] {
  const { peerId, final } = incoming

  if (!final) {
    const next = lines.filter((l) => !(l.peerId === peerId && !l.final))
    return [...next, { ...incoming, final: false, at: now }]
  }

  // Drop this peer's draft — the final is the same sentence, finished.
  const withoutDraft = lines.filter((l) => !(l.peerId === peerId && !l.final))

  // The speaker's own echo: same peer, same words, already on screen without an
  // id. Adopt the id and keep the line where it is, translation included.
  const echoIndex = withoutDraft.findIndex(
    (l) =>
      l.final &&
      l.peerId === peerId &&
      l.id === undefined &&
      l.text === incoming.text,
  )
  if (echoIndex !== -1 && incoming.id !== undefined) {
    const merged = [...withoutDraft]
    merged[echoIndex] = { ...merged[echoIndex], id: incoming.id }
    return merged
  }

  // The same line arriving twice with the same id — a reconnect replaying, or
  // two nodes both delivering. Idempotent rather than doubled.
  if (incoming.id !== undefined && withoutDraft.some((l) => l.id === incoming.id)) {
    return withoutDraft
  }

  return [...withoutDraft, { ...incoming, final: true, at: now }]
}

/**
 * Attaches a translation to the line it belongs to.
 *
 * <p>Silently does nothing when that line has already aged off the screen, which
 * is normal rather than exceptional: the translation lost a race it was never
 * going to win, and the transcript panel has it either way.
 */
export function applyTranslation(
  lines: SubtitleLine[],
  update: { id: number; translation: string; translationLang: string },
): SubtitleLine[] {
  let changed = false
  const next = lines.map((line) => {
    if (line.id !== update.id) return line
    changed = true
    return {
      ...line,
      translation: update.translation,
      translationLang: update.translationLang,
    }
  })
  // The same array back when nothing matched, so React does not re-render a
  // subtitle track on every translation for a line that has already gone.
  return changed ? next : lines
}

/**
 * The lines that should be on screen now, oldest first.
 *
 * <p>Expiry is computed on read rather than by a timer per line. A timer would
 * mean the track only updates when a timer fires; this way any re-render — a new
 * line, a translation, the clock tick the overlay already runs — is enough, and
 * a tab that was backgrounded for ten minutes comes back correct instead of
 * flushing ten minutes of subtitles at once.
 */
export function visible(
  lines: SubtitleLine[],
  now: number,
  max = MAX_VISIBLE,
): SubtitleLine[] {
  const alive = lines.filter((line) =>
    line.final ? now - line.at < HOLD_MS : now - line.at < STALE_MS,
  )
  return alive.slice(-max)
}

/**
 * Whether the track still holds anything, expired or not.
 *
 * <p>Used to decide whether it is worth pruning. Keeping expired lines in state
 * forever would leak a meeting's worth of them into memory even though none of
 * it is ever drawn.
 */
export function prune(lines: SubtitleLine[], now: number): SubtitleLine[] {
  const alive = lines.filter((line) =>
    line.final ? now - line.at < HOLD_MS : now - line.at < STALE_MS,
  )
  return alive.length === lines.length ? lines : alive
}
