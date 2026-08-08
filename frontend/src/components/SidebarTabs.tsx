import { useRef } from 'react'

export interface TabDescriptor<Id extends string> {
  id: Id
  label: string
}

interface SidebarTabsProps<Id extends string> {
  tabs: TabDescriptor<Id>[]
  active: Id
  onSelect: (id: Id) => void
}

/**
 * The sidebar's tab strip, as an actual tablist.
 *
 * <p>It was a `nav` of buttons with `aria-pressed`, which a screen reader
 * announces as seven independent toggles rather than one control with seven
 * settings — and which puts seven stops in the tab order before anyone reaches
 * the panel those tabs are for.
 *
 * <p>So: one stop for the whole strip (roving tabindex), arrow keys to move
 * between tabs, Home and End for the ends. That is the ARIA authoring practice
 * for a tablist, and it is also just faster with a keyboard.
 *
 * <p>Selection follows focus, as it does for a tablist whose panels are already
 * rendered: there is nothing to load, so making someone press Enter as well
 * would be ceremony.
 */
export function SidebarTabs<Id extends string>({ tabs, active, onSelect }: SidebarTabsProps<Id>) {
  const strip = useRef<HTMLDivElement>(null)

  const move = (from: number, to: number) => {
    const index = (to + tabs.length) % tabs.length
    if (index === from) return
    onSelect(tabs[index].id)
    // Focus has to follow, or the arrow keys move the selection out from under
    // the thing the user is still pointing at.
    const buttons = strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[index]?.focus()
  }

  return (
    <div className="sidebar__tabs" role="tablist" aria-label="側邊面板" ref={strip}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          className="sidebar__tab"
          role="tab"
          type="button"
          aria-selected={active === tab.id}
          aria-controls={`panel-${tab.id}`}
          // One stop for the strip: only the selected tab is reachable by Tab,
          // and the arrows do the rest.
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(e) => {
            const step =
              e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (step) {
              e.preventDefault()
              move(index, index + step)
              return
            }
            if (e.key === 'Home') {
              e.preventDefault()
              move(index, 0)
            } else if (e.key === 'End') {
              e.preventDefault()
              move(index, tabs.length - 1)
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
