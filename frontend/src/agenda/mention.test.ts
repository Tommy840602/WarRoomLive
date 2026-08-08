import { describe, expect, it } from 'vitest'
import { completeMention, mentionAt, suggest } from './mention'

describe('mentionAt', () => {
  it('finds the mention the caret is inside', () => {
    const line = '寄簡報 @bo'
    expect(mentionAt(line, line.length)).toEqual({ start: 4, end: 7, query: 'bo' })
  })

  it('opens on a bare @, so typing one shows the room', () => {
    // This is what makes the feature discoverable rather than a syntax you have
    // to already know.
    expect(mentionAt('寄簡報 @', 5)).toEqual({ start: 4, end: 5, query: '' })
  })

  it('finds one at the very start of the line', () => {
    expect(mentionAt('@al', 3)).toEqual({ start: 0, end: 3, query: 'al' })
  })

  it('does not treat an email address as a mention', () => {
    // `alice@example` is one word, not a tag on `example`.
    expect(mentionAt('alice@example', 13)).toBeNull()
  })

  it('is null when the caret has left the token', () => {
    // Otherwise the picker hangs over an unrelated part of the line.
    const line = '@bob 明天'
    expect(mentionAt(line, line.length)).toBeNull()
  })

  it('reads only up to the caret, not the whole token', () => {
    // Typing in the middle of an existing name should filter on what is to the
    // left of the caret.
    const line = '@bobby'
    expect(mentionAt(line, 3)).toEqual({ start: 0, end: 6, query: 'bo' })
  })

  it('is null where there is no mention at all', () => {
    expect(mentionAt('寄簡報 明天15:00', 5)).toBeNull()
    expect(mentionAt('', 0)).toBeNull()
  })

  it('handles a caret outside the string rather than throwing', () => {
    expect(mentionAt('@bob', 99)).toBeNull()
    expect(mentionAt('@bob', -1)).toBeNull()
  })

  it('works with a CJK name, like the parser does', () => {
    const line = '@小'
    expect(mentionAt(line, line.length)).toEqual({ start: 0, end: 2, query: '小' })
  })
})

describe('completeMention', () => {
  it('replaces the token and leaves the caret after it', () => {
    const line = '寄簡報 @bo'
    const token = mentionAt(line, line.length)!
    expect(completeMention(line, token, 'bob')).toEqual({
      line: '寄簡報 @bob ',
      caret: 9,
    })
  })

  it('keeps what follows the mention', () => {
    const line = '@bo 明天15:00'
    const token = mentionAt(line, 3)!
    expect(completeMention(line, token, 'bob').line).toBe('@bob 明天15:00')
  })

  it('does not add a second space when one is already there', () => {
    const line = '@bo 明天'
    const token = mentionAt(line, 3)!
    expect(completeMention(line, token, 'bob').line).toBe('@bob 明天')
  })

  it('completes a bare @ into a whole mention', () => {
    const line = '寄簡報 @'
    const token = mentionAt(line, line.length)!
    expect(completeMention(line, token, '小明').line).toBe('寄簡報 @小明 ')
  })

  it('replaces the whole token when the caret is mid-name', () => {
    // Correcting `@bobby` to `@bob` must not leave `@bobby` behind.
    const line = '@bobby'
    const token = mentionAt(line, 3)!
    expect(completeMention(line, token, 'bob').line).toBe('@bob ')
  })
})

describe('suggest', () => {
  const room = ['Alice', 'Bob', 'Michal', '小明']

  it('offers everyone for a bare @', () => {
    expect(suggest(room, '')).toEqual(room)
  })

  it('puts prefix matches before contained ones', () => {
    // Somebody typing `al` means Alice far more often than Michal.
    expect(suggest(room, 'al')).toEqual(['Alice', 'Michal'])
  })

  it('ignores case, because nobody capitalises inside a tag', () => {
    expect(suggest(room, 'BO')).toEqual(['Bob'])
  })

  it('matches a CJK name', () => {
    expect(suggest(room, '小')).toEqual(['小明'])
  })

  it('drops duplicates and blanks rather than offering them', () => {
    expect(suggest(['Alice', 'alice', '  ', ''], '')).toEqual(['Alice'])
  })

  it('is bounded, so the list cannot cover the panel', () => {
    const many = Array.from({ length: 30 }, (_, i) => `person${i}`)
    expect(suggest(many, '').length).toBe(6)
  })

  it('returns nothing when nobody matches', () => {
    expect(suggest(room, 'zzz')).toEqual([])
  })
})
