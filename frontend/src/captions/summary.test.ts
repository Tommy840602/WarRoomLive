import { describe, expect, it } from 'vitest'
import { parseSummary, tasksOf } from './summary'

const SAMPLE = `## 重點

- 討論了登入問題
- 排了下週的上線

## 決議

- 這個功能下週上線

## 待辦

- [ ] 修好登入 — @小明
- [x] 準備簡報 — @Bob
- [ ] 找法務確認
`

describe('parseSummary', () => {
  it('reads the three sections the summarizer promises', () => {
    const sections = parseSummary(SAMPLE)
    expect(sections.map((s) => s.heading)).toEqual(['重點', '決議', '待辦'])
    expect(sections[0].points).toHaveLength(2)
  })

  it('reads a task, its owner and whether it is done', () => {
    const tasks = tasksOf(parseSummary(SAMPLE))
    expect(tasks).toHaveLength(3)
    expect(tasks[0]).toEqual({ text: '修好登入', owner: '小明', done: false })
    expect(tasks[1].done).toBe(true)
  })

  it('leaves the owner off when nobody was named', () => {
    // The summarizer is told not to invent one, so an absent owner is the model
    // being honest and must not become an owner called "".
    const tasks = tasksOf(parseSummary(SAMPLE))
    expect(tasks[2]).toEqual({ text: '找法務確認', owner: undefined, done: false })
  })

  it('keeps a bullet that does not match the format instead of dropping it', () => {
    const sections = parseSummary('## 重點\n這不是項目符號\n- 這是')
    expect(sections[0].points).toEqual(['這不是項目符號', '這是'])
  })

  it('keeps text that appears before any heading', () => {
    const sections = parseSummary('開場白\n\n## 重點\n- 一件事')
    expect(sections[0].heading).toBe('')
    expect(sections[0].points).toEqual(['開場白'])
  })

  it('handles an em dash, an en dash and a hyphen before the owner', () => {
    const tasks = tasksOf(
      parseSummary('## 待辦\n- [ ] a — @x\n- [ ] b – @y\n- [ ] c - @z'),
    )
    expect(tasks.map((t) => t.owner)).toEqual(['x', 'y', 'z'])
  })

  it('does not mistake a dash inside a task for an owner separator', () => {
    const tasks = tasksOf(parseSummary('## 待辦\n- [ ] 修好 A - B 的整合'))
    expect(tasks[0]).toEqual({ text: '修好 A - B 的整合', owner: undefined, done: false })
  })

  it('survives an empty or missing summary rather than throwing', () => {
    expect(parseSummary('')).toEqual([])
    expect(parseSummary(undefined as unknown as string)).toEqual([])
  })
})
