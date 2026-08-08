import { bilingual } from '../captions/lang'
import type { SubtitleLine } from '../captions/subtitle'

interface CaptionOverlayProps {
  lines: SubtitleLine[]
}

/**
 * Subtitles, with the video, where subtitles go.
 *
 * <p>Not in the sidebar. A subtitle is read while looking at the person
 * speaking, and putting it in a panel means choosing between watching the room
 * and reading it — which is exactly the choice the feature exists to remove.
 *
 * <p><strong>Both languages, always, in the same order.</strong> Nobody picks a
 * side: this is a cross-department room where half the people want each, so
 * everybody gets both, Chinese above English every time. Ordering by whichever
 * language happened to be spoken would make the pair swap places between one
 * sentence and the next; letting the reader choose would make the language
 * selector mean two unrelated things — what I am speaking, and what I am reading.
 *
 * <p>A live region, so a screen reader announces lines as they arrive. Polite,
 * and only the settled ones: announcing every revision of a sentence being
 * recognised would make the room unlistenable.
 */
export function CaptionOverlay({ lines }: CaptionOverlayProps) {
  if (lines.length === 0) return null

  return (
    <div className="captions" aria-live="polite" aria-atomic="false" aria-label="即時字幕">
      {lines.map((line) => (
        <p
          key={line.id ?? `${line.peerId}:${line.at}`}
          className={`caption${line.final ? '' : ' caption--draft'}`}
        >
          <span className="caption__speaker">{line.speaker}</span>
          {bilingual(line).map((row, index) => (
            <span
              key={row.lang + index}
              // The translation is quieter than the words that were said. It is
              // a reading of them, and a room that can see which is which can
              // catch a translation that went wrong.
              className={row.original ? 'caption__text' : 'caption__text caption__alt'}
              lang={row.lang || undefined}
            >
              {row.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  )
}
