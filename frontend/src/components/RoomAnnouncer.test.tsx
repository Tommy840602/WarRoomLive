import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RoomAnnouncer } from './RoomAnnouncer'

const region = () => screen.getByRole('status').textContent

describe('RoomAnnouncer', () => {
  it('says nothing about the room as it was found', () => {
    // Otherwise joining a room of five reads out five arrivals that did not
    // happen.
    render(<RoomAnnouncer names={['Alice', 'Bob']} />)
    expect(region()).toBe('')
  })

  it('announces an arrival', () => {
    const { rerender } = render(<RoomAnnouncer names={['Alice']} />)
    rerender(<RoomAnnouncer names={['Alice', 'Bob']} />)
    expect(region()).toContain('Bob')
    expect(region()).toContain('加入')
  })

  it('announces a departure', () => {
    const { rerender } = render(<RoomAnnouncer names={['Alice', 'Bob']} />)
    rerender(<RoomAnnouncer names={['Alice']} />)
    expect(region()).toContain('Bob')
    expect(region()).toContain('離開')
  })

  it('announces the difference, not the roster', () => {
    // Re-reading every name on every change is how a live region gets muted.
    const { rerender } = render(<RoomAnnouncer names={['Alice', 'Bob', 'Carol']} />)
    rerender(<RoomAnnouncer names={['Alice', 'Bob', 'Carol', 'Dave']} />)
    expect(region()).toContain('Dave')
    expect(region()).not.toContain('Alice')
  })

  it('reports both directions from one change', () => {
    const { rerender } = render(<RoomAnnouncer names={['Alice', 'Bob']} />)
    rerender(<RoomAnnouncer names={['Alice', 'Carol']} />)
    expect(region()).toContain('Carol')
    expect(region()).toContain('Bob')
  })

  it('stays quiet when nothing changed', () => {
    const { rerender } = render(<RoomAnnouncer names={['Alice']} />)
    rerender(<RoomAnnouncer names={['Alice', 'Bob']} />)
    const after = region()
    // A re-render for an unrelated reason must not repeat the last thing said.
    rerender(<RoomAnnouncer names={['Alice', 'Bob']} />)
    expect(region()).toBe(after)
  })

  it('is polite, so it waits for a gap rather than cutting in', () => {
    render(<RoomAnnouncer names={[]} />)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
  })
})
