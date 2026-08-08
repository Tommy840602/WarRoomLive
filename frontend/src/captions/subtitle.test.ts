import { describe, expect, it } from 'vitest'
import {
  HOLD_MS,
  MAX_VISIBLE,
  STALE_MS,
  applyCaption,
  applyTranslation,
  prune,
  visible,
  type SubtitleLine,
} from './subtitle'

const caption = (over: Partial<Parameters<typeof applyCaption>[1]> = {}) => ({
  peerId: 'p1',
  speaker: 'Alice',
  text: 'hello',
  lang: 'en-US',
  final: false,
  ...over,
})

describe('applyCaption', () => {
  it('replaces a peer\'s draft instead of stacking revisions', () => {
    // Otherwise the sentence prints itself one revision at a time.
    let lines = applyCaption([], caption({ text: 'he' }), 1000)
    lines = applyCaption(lines, caption({ text: 'hello wo' }), 1100)
    lines = applyCaption(lines, caption({ text: 'hello world' }), 1200)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('hello world')
  })

  it('keeps one draft per speaker, not one overall', () => {
    let lines = applyCaption([], caption({ peerId: 'p1', text: 'alice talking' }), 1000)
    lines = applyCaption(lines, caption({ peerId: 'p2', speaker: 'Bob', text: 'bob too' }), 1010)
    expect(lines).toHaveLength(2)
  })

  it('lets the final replace the draft it was drafting', () => {
    let lines = applyCaption([], caption({ text: 'hello wor' }), 1000)
    lines = applyCaption(lines, caption({ text: 'hello world.', final: true, id: 7 }), 1200)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ text: 'hello world.', final: true, id: 7 })
  })

  it('merges the speaker\'s own echo instead of showing it twice', () => {
    // The speaker rendered this locally the moment they said it; the server's
    // echo exists only to hand over the id the translation will be keyed by.
    let lines = applyCaption([], caption({ text: '你好', final: true }), 1000)
    lines = applyCaption(lines, caption({ text: '你好', final: true, id: 42 }), 1050)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(42)
  })

  it('keeps a translation already attached when the echo arrives', () => {
    let lines = applyCaption([], caption({ text: '你好', final: true }), 1000)
    lines[0] = { ...lines[0], translation: 'Hello', translationLang: 'en' }
    lines = applyCaption(lines, caption({ text: '你好', final: true, id: 42 }), 1050)
    expect(lines[0].translation).toBe('Hello')
  })

  it('does not merge a different sentence from the same speaker', () => {
    let lines = applyCaption([], caption({ text: '你好', final: true }), 1000)
    lines = applyCaption(lines, caption({ text: '再見', final: true, id: 43 }), 1050)
    expect(lines).toHaveLength(2)
  })

  it('is idempotent for a line that arrives twice with the same id', () => {
    // A reconnect replaying, or two nodes both delivering.
    let lines = applyCaption([], caption({ text: 'hi', final: true, id: 9 }), 1000)
    lines = applyCaption(lines, caption({ text: 'hi', final: true, id: 9 }), 1400)
    expect(lines).toHaveLength(1)
  })

  it('keeps the same sentence said twice by two different people', () => {
    let lines = applyCaption([], caption({ peerId: 'p1', text: '好', final: true, id: 1 }), 1000)
    lines = applyCaption(
      lines,
      caption({ peerId: 'p2', speaker: 'Bob', text: '好', final: true, id: 2 }),
      1010,
    )
    expect(lines).toHaveLength(2)
  })
})

describe('applyTranslation', () => {
  it('attaches to the line with that id', () => {
    const lines = applyCaption([], caption({ text: '你好', final: true, id: 5 }), 1000)
    const next = applyTranslation(lines, { id: 5, translation: 'Hello', translationLang: 'en' })
    expect(next[0].translation).toBe('Hello')
  })

  it('returns the same array when the line has already gone', () => {
    // Identity matters: a changed array re-renders the whole track, and a
    // translation for a line nobody can see should cost nothing.
    const lines = applyCaption([], caption({ text: '你好', final: true, id: 5 }), 1000)
    const next = applyTranslation(lines, { id: 99, translation: 'x', translationLang: 'en' })
    expect(next).toBe(lines)
  })
})

describe('visible', () => {
  const at = (over: Partial<SubtitleLine>): SubtitleLine => ({
    peerId: 'p1',
    speaker: 'A',
    text: 't',
    lang: 'en-US',
    final: true,
    at: 0,
    ...over,
  })

  it('drops a finished line once it has had its time', () => {
    const lines = [at({ at: 1000 })]
    expect(visible(lines, 1000 + HOLD_MS - 1)).toHaveLength(1)
    expect(visible(lines, 1000 + HOLD_MS + 1)).toHaveLength(0)
  })

  it('gives an unfinished line longer, then drops it too', () => {
    // Recognition can stop mid-sentence; without this the half-sentence stays
    // on screen for the rest of the meeting.
    const lines = [at({ final: false, at: 1000 })]
    expect(visible(lines, 1000 + HOLD_MS + 1)).toHaveLength(1)
    expect(visible(lines, 1000 + STALE_MS + 1)).toHaveLength(0)
  })

  it('shows the newest few and no more', () => {
    const lines = Array.from({ length: 8 }, (_, i) => at({ id: i, at: 1000 }))
    const shown = visible(lines, 1001)
    expect(shown).toHaveLength(MAX_VISIBLE)
    expect(shown[shown.length - 1].id).toBe(7)
  })
})

describe('prune', () => {
  it('returns the same array when nothing has expired', () => {
    const lines = applyCaption([], caption({ final: true }), 1000)
    expect(prune(lines, 1100)).toBe(lines)
  })

  it('drops what has expired, so a long meeting does not accumulate', () => {
    const lines = applyCaption([], caption({ final: true }), 1000)
    expect(prune(lines, 1000 + STALE_MS + 1)).toHaveLength(0)
  })
})
