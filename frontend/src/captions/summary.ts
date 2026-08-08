/**
 * Reading the summary's Markdown back into the three sections it promised.
 *
 * <p>A parser rather than a Markdown library, and a deliberately narrow one. The
 * summarizer is asked for exactly three headings and bullets underneath them, so
 * what needs rendering is exactly that — headings, bullets, and task bullets with
 * an owner. Pulling in a general Markdown renderer to display a shape we
 * ourselves specified would add a dependency, and with it the ability for a
 * model to put a table or an image or a link into a meeting record.
 *
 * <p>Anything that does not match falls through as a plain bullet rather than
 * being dropped. A model that ignores the format is a bad summary, but silently
 * eating half of it would make that look like a bug in the panel.
 */

export interface SummaryTask {
  text: string
  /** The `@name` the model attributed it to, when it named one. */
  owner?: string
  done: boolean
}

export interface SummarySection {
  heading: string
  /** Bullets that are not tasks. */
  points: string[]
  /** Bullets written as checkboxes, which is how action items come back. */
  tasks: SummaryTask[]
}

const HEADING = /^#{1,6}\s+(.*)$/
const TASK = /^[-*]\s+\[( |x|X)\]\s+(.*)$/
const BULLET = /^[-*]\s+(.*)$/

/** Splits `任務 — @小明` into its two halves, on either dash the model may use. */
function splitOwner(text: string): { text: string; owner?: string } {
  const match = text.match(/^(.*?)\s*[—–-]\s*@(\S+)\s*$/u)
  if (!match) return { text: text.trim() }
  return { text: match[1].trim(), owner: match[2] }
}

export function parseSummary(markdown: string): SummarySection[] {
  const sections: SummarySection[] = []
  let current: SummarySection | null = null

  for (const raw of (markdown ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue

    const heading = line.match(HEADING)
    if (heading) {
      current = { heading: heading[1].trim(), points: [], tasks: [] }
      sections.push(current)
      continue
    }
    // Text before any heading still belongs somewhere: a model that opened with
    // a sentence should not have it disappear.
    if (!current) {
      current = { heading: '', points: [], tasks: [] }
      sections.push(current)
    }

    const task = line.match(TASK)
    if (task) {
      const { text, owner } = splitOwner(task[2])
      current.tasks.push({ text, owner, done: task[1].toLowerCase() === 'x' })
      continue
    }
    const bullet = line.match(BULLET)
    current.points.push(bullet ? bullet[1].trim() : line)
  }

  return sections
}

/** Every action item across the summary, for the "add to the to-do list" path. */
export function tasksOf(sections: SummarySection[]): SummaryTask[] {
  return sections.flatMap((section) => section.tasks)
}
