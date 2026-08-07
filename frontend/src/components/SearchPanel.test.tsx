import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SearchPanel, SEARCH_PAGE_SIZE, type SearchHit } from './SearchPanel'

const hit = (text: string, room = 'alpha'): SearchHit => ({
  room,
  fromId: 'p1',
  name: 'Alice',
  text,
  ts: 1_760_000_000_000,
})

const fullPage = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => hit(`hit ${i}`))

async function search(term: string) {
  // fireEvent.change, not a raw value assignment: React tracks the input's value
  // through its own setter, so assigning directly leaves the component's state
  // untouched and the field reads as empty.
  fireEvent.change(screen.getByLabelText('搜尋關鍵字'), { target: { value: term } })
  await act(async () => screen.getByRole('button', { name: '🔍' }).click())
}

describe('SearchPanel', () => {
  it('scopes to this room by default, and only searches everywhere when asked', async () => {
    const onSearch = vi.fn().mockResolvedValue([hit('deploy plan')])
    render(<SearchPanel onSearch={onSearch} />)

    await search('deploy')
    expect(onSearch).toHaveBeenCalledWith('deploy', true, 0)

    await act(async () => screen.getByRole('checkbox').click())
    await search('deploy')
    expect(onSearch).toHaveBeenLastCalledWith('deploy', false, 0)
  })

  it('distinguishes no matches from no search', async () => {
    // Before the first query there is nothing to say; after one that matched
    // nothing there is.
    const onSearch = vi.fn().mockResolvedValue([])
    render(<SearchPanel onSearch={onSearch} />)
    expect(screen.queryByText(/沒有符合/)).toBeNull()

    await search('nothing')
    await waitFor(() => expect(screen.getByText(/沒有符合/)).toBeTruthy())
  })

  it('offers a next page only when the page came back full', async () => {
    // A short page is the end of the results — offering "next" there would
    // hand the user an empty screen.
    const onSearch = vi.fn().mockResolvedValue([hit('one')])
    const { rerender } = render(<SearchPanel onSearch={onSearch} />)
    await search('one')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /下一頁/ }) as HTMLButtonElement).disabled)
        .toBe(true),
    )

    const full = vi.fn().mockResolvedValue(fullPage)
    rerender(<SearchPanel onSearch={full} />)
    await search('many')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /下一頁/ }) as HTMLButtonElement).disabled)
        .toBe(false),
    )

    await act(async () => screen.getByRole('button', { name: /下一頁/ }).click())
    expect(full).toHaveBeenLastCalledWith('many', true, SEARCH_PAGE_SIZE)
  })

  it('reports that search is unavailable instead of showing an empty result', async () => {
    // "Nothing matched" and "nothing is indexed" are different answers, and the
    // events overlay is optional.
    const onSearch = vi.fn().mockRejectedValue(new Error('這個部署沒有啟用訊息搜尋'))
    render(<SearchPanel onSearch={onSearch} />)

    await search('anything')
    await waitFor(() => expect(screen.getByText(/沒有啟用訊息搜尋/)).toBeTruthy())
    expect(screen.queryByText(/沒有符合/)).toBeNull()
  })

  it('does not run an empty query', async () => {
    const onSearch = vi.fn().mockResolvedValue([])
    render(<SearchPanel onSearch={onSearch} />)

    await search('   ')
    expect(onSearch).not.toHaveBeenCalled()
  })
})
