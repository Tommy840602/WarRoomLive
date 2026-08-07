import { useCallback, useState } from 'react'

export interface SearchHit {
  room: string
  fromId: string
  name: string
  text: string
  ts: number
}

/** One page; the server clamps anything larger. */
const PAGE = 25

interface SearchPanelProps {
  /** Runs a query. Rejects when the search projection is not available. */
  onSearch: (query: string, thisRoomOnly: boolean, offset: number) => Promise<SearchHit[]>
}

/**
 * Full-text search over chat history.
 *
 * <p>The API has existed since the indexer landed, with nothing in the app able
 * to call it — a read model nobody could read. Results are paged rather than
 * scrolled infinitely because the endpoint is paged: pretending otherwise would
 * mean either a silent cap or a request for the whole table.
 *
 * <p>Scoped to this room by default. A war room is where you look for something
 * you said <em>here</em>; searching everywhere is the deliberate act.
 */
export function SearchPanel({ onSearch }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [thisRoomOnly, setThisRoomOnly] = useState(true)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (nextOffset: number) => {
    const term = query.trim()
    if (!term) return
    setBusy(true)
    setError(null)
    try {
      setHits(await onSearch(term, thisRoomOnly, nextOffset))
      setOffset(nextOffset)
    } catch (e) {
      setHits(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [onSearch, query, thisRoomOnly])

  return (
    <aside className="search">
      <h2 className="search__title">搜尋訊息</h2>

      <form
        className="search__form"
        onSubmit={(e) => {
          e.preventDefault()
          void run(0)
        }}
      >
        <input
          className="search__input"
          type="search"
          value={query}
          placeholder="關鍵字"
          aria-label="搜尋關鍵字"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="search__go" type="submit" disabled={busy || !query.trim()}>
          {busy ? '…' : '🔍'}
        </button>
      </form>

      <label className="search__scope">
        <input
          type="checkbox"
          checked={thisRoomOnly}
          onChange={(e) => {
            setThisRoomOnly(e.target.checked)
            // The old results answered a different question.
            setHits(null)
          }}
        />
        只搜尋這個房間
      </label>

      {error && <p className="search__error">⚠️ {error}</p>}

      {hits !== null && hits.length === 0 && (
        <p className="search__empty">沒有符合的訊息</p>
      )}

      {hits !== null && hits.length > 0 && (
        <>
          <ul className="search__results">
            {hits.map((hit) => (
              <li key={`${hit.ts}-${hit.fromId}-${hit.text}`} className="search__hit">
                <span className="search__hit-head">
                  <span className="search__hit-name">{hit.name}</span>
                  {!thisRoomOnly && <span className="search__hit-room">#{hit.room}</span>}
                  <span className="search__hit-when">{formatWhen(hit.ts)}</span>
                </span>
                <span className="search__hit-text">{hit.text}</span>
              </li>
            ))}
          </ul>
          <div className="search__paging">
            <button
              disabled={busy || offset === 0}
              onClick={() => void run(Math.max(0, offset - PAGE))}
            >
              ← 上一頁
            </button>
            {/* A full page means there may be more; a short one means there is not. */}
            <button disabled={busy || hits.length < PAGE} onClick={() => void run(offset + PAGE)}>
              下一頁 →
            </button>
          </div>
        </>
      )}
    </aside>
  )
}

export const SEARCH_PAGE_SIZE = PAGE

function formatWhen(ts: number): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
