import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemberList, type Member } from './MemberList'

const members: Member[] = [
  { id: 'alice', name: 'Alice', isSelf: true },
  { id: 'bob', name: 'Bob', isSelf: false },
]

describe('MemberList', () => {
  it('marks the host and nobody else', () => {
    render(<MemberList members={members} hostId="bob" />)
    const crowns = screen.getAllByLabelText('主持人')
    expect(crowns).toHaveLength(1)
    expect(crowns[0].closest('li')?.textContent).toContain('Bob')
  })

  it('offers kick buttons only to the host, and never against yourself', () => {
    const onKick = vi.fn()
    const { rerender } = render(
      <MemberList members={members} hostId="alice" canKick onKick={onKick} />,
    )
    // One button, for the other participant.
    const kicks = screen.getAllByRole('button', { name: /移出/ })
    expect(kicks).toHaveLength(1)
    expect(kicks[0].getAttribute('aria-label')).toBe('移出 Bob')
    kicks[0].click()
    expect(onKick).toHaveBeenCalledWith('bob')

    // A non-host viewer gets none — the UI must not offer what the server refuses.
    rerender(<MemberList members={members} hostId="bob" canKick={false} onKick={onKick} />)
    expect(screen.queryAllByRole('button', { name: /移出/ })).toHaveLength(0)
  })

  it('shows the padlock only while the room is locked', () => {
    const { rerender } = render(<MemberList members={members} locked />)
    expect(screen.getByLabelText('房間已鎖定')).toBeTruthy()
    rerender(<MemberList members={members} locked={false} />)
    expect(screen.queryByLabelText('房間已鎖定')).toBeNull()
  })

  it('surfaces per-member mute, camera and hand state', () => {
    render(<MemberList members={[{ ...members[1], audioOff: true, videoOff: true, handRaised: true }]} />)
    expect(screen.getByLabelText('靜音')).toBeTruthy()
    expect(screen.getByLabelText('關閉視訊')).toBeTruthy()
    expect(screen.getByLabelText('舉手')).toBeTruthy()
  })
})
