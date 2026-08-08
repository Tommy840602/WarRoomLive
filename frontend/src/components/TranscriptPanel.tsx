import { useMemo, useState } from 'react'
import { parseSummary, type SummaryTask } from '../captions/summary'
import type { Meeting, TranscriptLine } from '../signaling/types'

export interface MeetingSummary {
  meetingId: number
  summaryMd: string
  model: string
  lineCount: number
  generatedAt: string
}

interface TranscriptPanelProps {
  lines: TranscriptLine[]
  /** Newest first, as the meetings endpoint returns them. */
  meetings: Meeting[]
  summary: MeetingSummary | null
  /** False when no language model is configured; the button is not offered. */
  canSummarize: boolean
  onSummarize: (meetingId: number, regenerate: boolean) => Promise<void>
  /** Puts one action item on the room's to-do list. */
  onAddTask: (line: string) => void
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * What was said, and what it came to.
 *
 * <p>The summary sits above the transcript rather than below it, because the
 * order somebody needs them in is the reverse of the order they were produced.
 * Nobody opens this panel to read an hour of speech; they open it to find out
 * what was decided, and read the words only when the summary does not answer it.
 *
 * <p>Action items are offered to the to-do list rather than pushed onto it. A
 * model's reading of "someone should look at that" is not a commitment anybody
 * made, and a summary that silently filled the room's task list would make
 * everyone stop trusting the task list.
 */
export function TranscriptPanel({
  lines,
  meetings,
  summary,
  canSummarize,
  onSummarize,
  onAddTask,
}: TranscriptPanelProps) {
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())

  // The live one when the room is occupied, which it is whenever anyone is
  // looking at this. Falls back to the most recent closed meeting.
  const current = meetings.find((m) => m.live) ?? meetings[0]

  const sections = useMemo(
    () => (summary ? parseSummary(summary.summaryMd) : []),
    [summary],
  )

  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase()
    if (!needle) return lines
    return lines.filter(
      (line) =>
        line.text.toLocaleLowerCase().includes(needle) ||
        line.translation?.toLocaleLowerCase().includes(needle) ||
        line.speaker.toLocaleLowerCase().includes(needle),
    )
  }, [lines, filter])

  const summarize = async (regenerate: boolean) => {
    if (!current) return
    setBusy(true)
    setError(null)
    try {
      await onSummarize(current.id, regenerate)
    } catch (e) {
      setError(e instanceof Error ? e.message : '產生摘要失敗')
    } finally {
      setBusy(false)
    }
  }

  const addTask = (task: SummaryTask) => {
    // The capture line, not a structured create: it is the same one-line grammar
    // the agenda already parses, so an owner reaches the to-do list the way it
    // does when somebody types it.
    onAddTask(task.owner ? `${task.text} @${task.owner}` : task.text)
    setAdded((prev) => new Set(prev).add(task.text))
  }

  return (
    <div className="transcript">
      <h2 className="transcript__title">逐字稿</h2>

      <section className="summary" aria-label="重點摘要">
        {summary ? (
          <>
            {sections.map((section, index) => (
              <div className="summary__section" key={`${section.heading}-${index}`}>
                {section.heading && <h3 className="summary__heading">{section.heading}</h3>}
                {section.points.length > 0 && (
                  <ul className="summary__points">
                    {section.points.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                )}
                {section.tasks.length > 0 && (
                  <ul className="summary__tasks">
                    {section.tasks.map((task, i) => (
                      <li className="summary__task" key={i}>
                        <span className="summary__task-text">{task.text}</span>
                        {task.owner && <span className="chip chip--owner">@{task.owner}</span>}
                        <button
                          type="button"
                          className="summary__add"
                          disabled={added.has(task.text)}
                          onClick={() => addTask(task)}
                        >
                          {added.has(task.text) ? '已加入' : '加入待辦'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="summary__meta">
              由 {summary.model} 從 {summary.lineCount} 句逐字稿產生
            </p>
            {canSummarize && (
              <button
                type="button"
                className="summary__regen"
                disabled={busy}
                onClick={() => summarize(true)}
              >
                {busy ? '產生中…' : '重新產生'}
              </button>
            )}
          </>
        ) : canSummarize ? (
          <button
            type="button"
            className="summary__generate"
            disabled={busy || !current}
            onClick={() => summarize(false)}
          >
            {busy ? '產生中…' : '產生重點摘要'}
          </button>
        ) : (
          // Said plainly rather than hidden. A missing button reads as a bug;
          // this reads as a deployment that has not switched the feature on.
          <p className="transcript__empty">這個部署沒有設定語言模型,無法產生摘要。</p>
        )}
        {error && (
          <p className="summary__error" role="alert">
            {error}
          </p>
        )}
      </section>

      <label className="transcript__filter">
        <span className="visually-hidden">篩選逐字稿</span>
        <input
          type="search"
          value={filter}
          placeholder="搜尋這場會議說過的話"
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>

      {lines.length === 0 ? (
        <p className="transcript__empty">還沒有逐字稿。開啟字幕之後,說過的話會留在這裡。</p>
      ) : shown.length === 0 ? (
        <p className="transcript__empty">沒有符合「{filter}」的內容。</p>
      ) : (
        <ol className="transcript__lines">
          {shown.map((line) => (
            <li className="transcript__line" key={line.id}>
              <span className="transcript__time tabular">{time(line.spokenAt)}</span>
              <span className="transcript__speaker">{line.speaker}</span>
              <span className="transcript__text" lang={line.lang}>
                {line.text}
              </span>
              {line.translation && (
                <span className="transcript__alt" lang={line.translationLang}>
                  {line.translation}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
