/**
 * Finding and completing an `@` mention in a line being typed.
 *
 * Pure, and separate from the component, because all the fiddly parts are here:
 * where the token starts, what counts as still being inside it, and what the
 * line looks like after a name is chosen. A picker that inserts the name one
 * character to the left is not a rendering problem.
 */

/** Matches the assignee pattern in `capture.ts`, so what is suggested is what parses. */
const MENTION_CHAR = /[^\s@]/u

export interface MentionToken {
  /** Index of the `@`. */
  start: number
  /** Index just past the last character of the token. */
  end: number
  /** What has been typed after the `@`, possibly empty. */
  query: string
}

/**
 * The mention the caret is inside, if any.
 *
 * A mention starts at an `@` that begins the line or follows whitespace —
 * `a@b` is an email address, not a tag on `b`. The caret has to be inside the
 * token, because moving away from a mention should close the picker rather than
 * leave it hanging over an unrelated part of the line.
 */
export function mentionAt(line: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > line.length) return null

  let at = -1
  for (let i = caret - 1; i >= 0; i--) {
    const ch = line[i]
    if (ch === '@') {
      at = i
      break
    }
    if (!MENTION_CHAR.test(ch)) return null
  }
  if (at === -1) return null
  // `@` must open a word: an address like alice@example is not a mention.
  if (at > 0 && MENTION_CHAR.test(line[at - 1])) return null

  let end = at + 1
  while (end < line.length && MENTION_CHAR.test(line[end])) end++
  if (caret > end) return null

  return { start: at, end, query: line.slice(at + 1, caret) }
}

/**
 * The line with the mention completed, and where the caret goes.
 *
 * A trailing space is added when the mention is at the end, because the next
 * thing anybody types is the rest of the sentence and nobody wants to reach for
 * the space bar after choosing from a list.
 */
export function completeMention(
  line: string,
  token: MentionToken,
  name: string,
): { line: string; caret: number } {
  const before = line.slice(0, token.start)
  const after = line.slice(token.end)
  const needsSpace = after === '' || !after.startsWith(' ')
  const inserted = `@${name}${needsSpace ? ' ' : ''}`
  return { line: before + inserted + after, caret: before.length + inserted.length }
}

/**
 * Room members worth offering for a query.
 *
 * Prefix matches come before contained ones — someone typing `al` means Alice
 * far more often than they mean "Michal" — and the comparison is
 * case-insensitive because nobody capitalises inside a tag.
 *
 * An empty query offers everyone: typing `@` and seeing the room is the whole
 * point, and it is what makes this discoverable rather than a syntax you have
 * to already know.
 */
export function suggest(names: string[], query: string, limit = 6): string[] {
  const q = query.toLocaleLowerCase()
  const seen = new Set<string>()
  const unique = names.filter((n) => {
    const key = n.toLocaleLowerCase()
    if (!n.trim() || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!q) return unique.slice(0, limit)

  const starts: string[] = []
  const contains: string[] = []
  for (const name of unique) {
    const lower = name.toLocaleLowerCase()
    if (lower.startsWith(q)) starts.push(name)
    else if (lower.includes(q)) contains.push(name)
  }
  return [...starts, ...contains].slice(0, limit)
}
