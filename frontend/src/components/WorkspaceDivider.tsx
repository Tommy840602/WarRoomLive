import { useEffect, useRef } from 'react'
import { SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar } from '../layout/workspace'

interface WorkspaceDividerProps {
  width: number
  onChange: (width: number) => void
  /** Width of the whole workspace, so the drag cannot push the video to zero. */
  available: number
}

/** One press of an arrow key. Small enough to aim, large enough to get somewhere. */
const NUDGE = 24

/**
 * The handle between the video and the side panel.
 *
 * Dragging is the obvious way and the keyboard is the required one, so this is
 * a real `separator` with a value the arrow keys move — a div with a mousedown
 * handler would leave the layout adjustable by pointer only.
 *
 * The drag listens on the window rather than the handle, because a pointer
 * moving faster than React re-renders leaves the element behind, and a divider
 * that stops following the cursor feels broken.
 *
 * The listeners are attached **once**. An earlier version depended on the
 * current width, so every pointermove re-ran the effect, and the cleanup —
 * which also ended the drag — fired on the first movement: the divider moved
 * one step and let go. The live values are read through a ref instead, which is
 * what keeps the handler stable.
 */
export function WorkspaceDivider({ width, onChange, available }: WorkspaceDividerProps) {
  const dragging = useRef(false)
  const handleRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ onChange, available })
  latest.current = { onChange, available }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      const rect = handleRef.current?.parentElement?.getBoundingClientRect()
      if (!rect) return
      // The panel is on the right, so its width is whatever is left of the edge.
      latest.current.onChange(clampSidebar(rect.right - e.clientX, latest.current.available))
    }
    const stop = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('is-resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      stop()
    }
  }, [])

  return (
    <div
      ref={handleRef}
      className="divider"
      role="separator"
      tabIndex={0}
      aria-label="調整版面寬度"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      onPointerDown={() => {
        dragging.current = true
        // Text selection during a drag turns the whole page blue.
        document.body.classList.add('is-resizing')
      }}
      onKeyDown={(e) => {
        // Left widens the panel, because the panel's edge is what moves left.
        const by = e.key === 'ArrowLeft' ? NUDGE : e.key === 'ArrowRight' ? -NUDGE : 0
        if (!by) return
        e.preventDefault()
        onChange(clampSidebar(width + by, available))
      }}
      onDoubleClick={() => onChange(clampSidebar(320, available))}
      title="拖曳調整,或用左右鍵;雙擊回到預設"
    >
      <span className="divider__grip" aria-hidden="true" />
    </div>
  )
}
