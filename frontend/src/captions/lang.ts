/**
 * Which subtitle track a language tag belongs to, and how to order a line's two
 * languages.
 *
 * Mirrors `Lang.java` on the server, which does the same reduction before
 * deciding what to translate into. Kept in step by hand, like the signaling
 * envelope: both sides have to agree that `cmn-Hant-TW` is Chinese, or the
 * server translates a line the browser then files under the wrong heading.
 */

export type Track = 'zh' | 'en'

/**
 * The track a BCP-47 tag belongs to, or null when it is neither.
 *
 * Matched on the primary subtag — except that Mandarin and Cantonese carry
 * ISO-639-3 primary subtags (`cmn`, `yue`) that do not begin with `zh` at all,
 * which is the case a naive `startsWith('zh')` gets wrong on the exact locale a
 * Taiwanese room speaks.
 */
export function track(tag: string | undefined): Track | null {
  if (!tag) return null
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  if (['zh', 'cmn', 'yue', 'nan', 'hak', 'wuu'].includes(primary)) return 'zh'
  if (primary === 'en') return 'en'
  return null
}

export interface Utterance {
  text: string
  lang: string
  translation?: string
  translationLang?: string
}

export interface Rendered {
  text: string
  lang: string
  /** True for the words that were actually said, false for the translation. */
  original: boolean
}

/**
 * A line's languages, in a fixed order: Chinese first, then English.
 *
 * <p><strong>Both are always shown, and nobody chooses.</strong> An earlier
 * version put the reader's picked language on top, which meant the subtitle
 * changed shape depending on who was reading and made the language selector
 * mean two unrelated things at once — what I am speaking, and what I want to
 * read. In a room that is half Chinese and half English, everybody needs both
 * lines anyway; what they do not need is for the pair to swap places between one
 * utterance and the next depending on which language it was spoken in.
 *
 * <p>A fixed order also means the eye learns where to look. Ordering by
 * "original first" would put Chinese on top for one sentence and English on top
 * for the next, in the same conversation.
 *
 * <p>Untranslated lines, and lines in neither language, return the single row
 * they have — never a blank second line implying a translation that is not there.
 */
export function bilingual(line: Utterance): Rendered[] {
  const rows: Rendered[] = [{ text: line.text, lang: line.lang, original: true }]
  if (line.translation) {
    rows.push({
      text: line.translation,
      lang: line.translationLang ?? '',
      original: false,
    })
  }
  if (rows.length < 2) return rows

  const rank = (row: Rendered) => {
    const t = track(row.lang)
    // Anything unrecognised sorts last rather than jumping the queue: it is the
    // row we know least about.
    return t === 'zh' ? 0 : t === 'en' ? 1 : 2
  }
  return [...rows].sort((a, b) => rank(a) - rank(b))
}
