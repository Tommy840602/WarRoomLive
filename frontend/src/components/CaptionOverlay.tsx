import type { SubtitleLine } from '../captions/subtitle'

interface CaptionOverlayProps {
  lines: SubtitleLine[]
  /** Which language the reader wants on top. */
  prefer: 'zh' | 'en'
}

/**
 * Subtitles, over the video, where subtitles go.
 *
 * <p>Not in the sidebar. A subtitle is read while looking at the person
 * speaking, and putting it in a panel means choosing between watching the room
 * and reading it — which is exactly the choice the feature exists to remove.
 *
 * <p><strong>The reader's language goes on top.</strong> Somebody who has picked
 * English is reading the English line and glancing at the Chinese; putting the
 * original first because it is the original makes them read past a line they
 * cannot use, every time. The one that is not theirs stays visible and quieter —
 * translations are wrong sometimes, and a room that can see the original can
 * catch it.
 *
 * <p>A live region, so a screen reader announces lines as they settle. Polite,
 * and only the finished ones: announcing every revision of a sentence being
 * recognised would make the room unlistenable.
 */
export function CaptionOverlay({ lines, prefer }: CaptionOverlayProps) {
  if (lines.length === 0) return null

  return (
    <div className="captions" aria-live="polite" aria-atomic="false" aria-label="即時字幕">
      {lines.map((line) => {
        const original = { text: line.text, lang: line.lang }
        const translation = line.translation
          ? { text: line.translation, lang: line.translationLang ?? '' }
          : null
        // Preference only matters when there are two of them.
        const readerWantsTranslation =
          translation !== null && translation.lang === prefer
        const top = readerWantsTranslation ? translation : original
        const bottom = readerWantsTranslation ? original : translation

        return (
          <p
            key={line.id ?? `${line.peerId}:${line.at}`}
            className={`caption${line.final ? '' : ' caption--draft'}`}
          >
            <span className="caption__speaker">{line.speaker}</span>
            <span className="caption__text" lang={top.lang || undefined}>
              {top.text}
            </span>
            {bottom && (
              <span className="caption__alt" lang={bottom.lang || undefined}>
                {bottom.text}
              </span>
            )}
          </p>
        )
      })}
    </div>
  )
}
