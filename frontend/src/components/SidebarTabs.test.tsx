import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SidebarTabs } from './SidebarTabs'

const TABS = [
  { id: 'members' as const, label: '成員' },
  { id: 'agenda' as const, label: '議程' },
  { id: 'chat' as const, label: '聊天' },
]

const strip = (active: (typeof TABS)[number]['id'], onSelect = vi.fn()) => {
  render(<SidebarTabs tabs={TABS} active={active} onSelect={onSelect} />)
  return onSelect
}

describe('SidebarTabs', () => {
  it('is a tablist, not a row of toggle buttons', () => {
    // aria-pressed announced seven independent toggles rather than one control
    // with seven settings.
    strip('agenda')
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('議程')
  })

  it('points each tab at the panel it controls', () => {
    strip('agenda')
    expect(screen.getByRole('tab', { name: '議程' }).getAttribute('aria-controls')).toBe(
      'panel-agenda',
    )
  })

  it('puts one stop in the tab order, not one per panel', () => {
    // Seven panels meant seven stops before a keyboard reached any content.
    strip('agenda')
    const reachable = screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)
    expect(reachable).toHaveLength(1)
    expect(reachable[0].textContent).toBe('議程')
  })

  it('moves with the arrow keys', () => {
    const onSelect = strip('agenda')
    fireEvent.keyDown(screen.getByRole('tab', { name: '議程' }), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith('chat')

    fireEvent.keyDown(screen.getByRole('tab', { name: '議程' }), { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('members')
  })

  it('wraps at both ends rather than stopping', () => {
    const first = strip('members')
    fireEvent.keyDown(screen.getByRole('tab', { name: '成員' }), { key: 'ArrowLeft' })
    expect(first).toHaveBeenCalledWith('chat')
  })

  it('jumps to the ends with Home and End', () => {
    const onSelect = strip('agenda')
    fireEvent.keyDown(screen.getByRole('tab', { name: '議程' }), { key: 'End' })
    expect(onSelect).toHaveBeenLastCalledWith('chat')
    fireEvent.keyDown(screen.getByRole('tab', { name: '議程' }), { key: 'Home' })
    expect(onSelect).toHaveBeenLastCalledWith('members')
  })

  it('ignores keys that are not navigation', () => {
    const onSelect = strip('agenda')
    fireEvent.keyDown(screen.getByRole('tab', { name: '議程' }), { key: 'a' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still selects on a click', () => {
    const onSelect = strip('agenda')
    fireEvent.click(screen.getByRole('tab', { name: '聊天' }))
    expect(onSelect).toHaveBeenCalledWith('chat')
  })

  it('does not re-announce a move onto the tab already selected', () => {
    const onSelect = vi.fn()
    render(<SidebarTabs tabs={[TABS[0]]} active="members" onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: '成員' }), { key: 'ArrowRight' })
    // One tab: right wraps back to itself, which is not a selection.
    expect(onSelect).not.toHaveBeenCalled()
  })
})
