import { describe, expect, it } from 'vitest'
import { bilingual, track } from './lang'

describe('track', () => {
  it('recognises the tags Chrome actually reports', () => {
    // The one that matters: Taiwanese Mandarin comes back as `cmn-Hant-TW`,
    // which a naive startsWith('zh') gets wrong on this room's own locale.
    expect(track('cmn-Hant-TW')).toBe('zh')
    expect(track('zh-TW')).toBe('zh')
    expect(track('yue-Hant-HK')).toBe('zh')
    expect(track('en-US')).toBe('en')
    expect(track('en-GB')).toBe('en')
  })

  it('declines anything it is not sure about', () => {
    expect(track('ja-JP')).toBeNull()
    expect(track('')).toBeNull()
    expect(track(undefined)).toBeNull()
  })
})

describe('bilingual', () => {
  it('puts Chinese first whichever language was spoken', () => {
    // The point of a fixed order: the pair must not swap places between one
    // utterance and the next depending on who happened to be talking.
    const spokenZh = bilingual({
      text: '你好',
      lang: 'cmn-Hant-TW',
      translation: 'Hello',
      translationLang: 'en',
    })
    const spokenEn = bilingual({
      text: 'Hello',
      lang: 'en-US',
      translation: '你好',
      translationLang: 'zh',
    })
    expect(spokenZh.map((r) => r.text)).toEqual(['你好', 'Hello'])
    expect(spokenEn.map((r) => r.text)).toEqual(['你好', 'Hello'])
  })

  it('marks which row was actually said', () => {
    const rows = bilingual({
      text: 'Hello',
      lang: 'en-US',
      translation: '你好',
      translationLang: 'zh',
    })
    expect(rows[0]).toMatchObject({ text: '你好', original: false })
    expect(rows[1]).toMatchObject({ text: 'Hello', original: true })
  })

  it('gives one row when there is no translation yet', () => {
    // A blank second line would imply a translation that has not arrived, or is
    // never coming because none is configured.
    const rows = bilingual({ text: '你好', lang: 'cmn-Hant-TW' })
    expect(rows).toHaveLength(1)
    expect(rows[0].original).toBe(true)
  })

  it('keeps a line in neither language rather than dropping it', () => {
    const rows = bilingual({ text: 'こんにちは', lang: 'ja-JP' })
    expect(rows.map((r) => r.text)).toEqual(['こんにちは'])
  })

  it('sorts an unrecognised language after the two it knows', () => {
    const rows = bilingual({
      text: 'こんにちは',
      lang: 'ja-JP',
      translation: '你好',
      translationLang: 'zh',
    })
    expect(rows.map((r) => r.text)).toEqual(['你好', 'こんにちは'])
  })
})
