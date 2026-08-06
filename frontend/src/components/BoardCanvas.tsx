import { useEffect, useMemo, useRef, useState } from 'react'
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
/** A finished pen stroke; immutable once appended to the shared array. */
interface StrokeData {
  id: string
  color: string
  size: number
  points: number[]
}

/** A sticky note; the whole value is replaced on move/edit (last write wins). */
interface StickyData {
  x: number
  y: number
  text: string
  color: string
}

interface RemotePresence {
  name: string
  color: string
  cursor?: { x: number; y: number } | null
  stroke?: StrokeData | null
}

const PEN_COLORS = ['#e6e8eb', '#f87171', '#fbbf24', '#4ade80', '#60a5fa']
const STICKY_COLORS = ['#fbbf24', '#4ade80', '#f9a8d4']
const STICKY_W = 140
const STICKY_H = 90
const BOARD_HEIGHT = 420

/**
 * Shared whiteboard on the same room Yjs document as the notes (types
 * `board:strokes` / `board:stickies`), so persistence, limits and events are
 * inherited from the collab service unchanged. Durable state commits on
 * pointer-up / drag-end; in-progress strokes and cursors ride the throttled
 * awareness channel and are never stored — the blueprint's durable/ephemeral
 * split, applied to drawing.
 */
export function BoardCanvas({
  doc,
  provider,
}: {
  doc: Y.Doc
  provider: HocuspocusProvider
}) {
  const strokesY = useMemo(() => doc.getArray<StrokeData>('board:strokes'), [doc])
  const stickiesY = useMemo(() => doc.getMap<StickyData>('board:stickies'), [doc])
  // Tracks local transactions only, so undo never reverts someone else's work.
  const undoManager = useMemo(() => new Y.UndoManager([strokesY, stickiesY]), [strokesY, stickiesY])

  const [strokes, setStrokes] = useState<StrokeData[]>([])
  const [stickies, setStickies] = useState<Array<[string, StickyData]>>([])
  const [remotes, setRemotes] = useState<RemotePresence[]>([])
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [, setDrawingTick] = useState(0)
  const [editing, setEditing] = useState<{ id: string; x: number; y: number; text: string } | null>(null)
  const [width, setWidth] = useState(760)

  const drawing = useRef<StrokeData | null>(null)
  const lastDragWrite = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Mirror the shared types into React state (and a test-visible summary).
  useEffect(() => {
    const sync = () => {
      setStrokes(strokesY.toArray())
      setStickies([...stickiesY.entries()])
      ;(window as unknown as Record<string, unknown>).__boardStats = {
        strokes: strokesY.length,
        stickies: stickiesY.size,
        stickyTexts: [...stickiesY.values()].map((s) => s.text),
      }
    }
    sync()
    strokesY.observe(sync)
    stickiesY.observe(sync)
    return () => {
      strokesY.unobserve(sync)
      stickiesY.unobserve(sync)
    }
  }, [strokesY, stickiesY])

  // Other participants' cursors and in-progress strokes from awareness.
  useEffect(() => {
    const awareness = provider.awareness
    if (!awareness) return
    const sync = () => {
      const states = [...awareness.getStates().entries()]
        .filter(([clientId]) => clientId !== awareness.clientID)
        .map(([, state]) => state as Record<string, unknown>)
        .filter((s) => s.boardCursor || s.boardStroke)
        .map((s) => {
          const user = s.user as { name?: string; color?: string } | undefined
          return {
            name: user?.name ?? '?',
            color: user?.color ?? '#9aa0a6',
            cursor: s.boardCursor as RemotePresence['cursor'],
            stroke: s.boardStroke as RemotePresence['stroke'],
          }
        })
      setRemotes(states)
    }
    awareness.on('change', sync)
    return () => {
      awareness.off('change', sync)
    }
  }, [provider])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const pointerDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    // Strokes start on the empty canvas only — not on stickies being dragged.
    if (e.target !== e.target.getStage()) return
    const p = e.target.getStage()?.getPointerPosition()
    if (!p) return
    drawing.current = { id: crypto.randomUUID(), color: penColor, size: 3, points: [p.x, p.y] }
  }

  const pointerMove = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const p = e.target.getStage()?.getPointerPosition()
    if (!p) return
    provider.setAwarenessField('boardCursor', { x: p.x, y: p.y })
    if (drawing.current) {
      drawing.current.points.push(p.x, p.y)
      provider.setAwarenessField('boardStroke', drawing.current)
      setDrawingTick((t) => t + 1)
    }
  }

  const pointerUp = () => {
    const stroke = drawing.current
    drawing.current = null
    provider.setAwarenessField('boardStroke', null)
    if (stroke && stroke.points.length >= 4) {
      doc.transact(() => strokesY.push([stroke]))
    }
    setDrawingTick((t) => t + 1)
  }

  const addSticky = () => {
    const id = crypto.randomUUID()
    stickiesY.set(id, {
      x: 24 + (stickiesY.size % 4) * (STICKY_W + 16),
      y: 24 + (stickiesY.size % 3) * 32,
      text: '雙擊編輯',
      color: STICKY_COLORS[stickiesY.size % STICKY_COLORS.length],
    })
  }

  const moveSticky = (id: string, data: StickyData, node: Konva.Node, finished: boolean) => {
    const now = Date.now()
    if (!finished && now - lastDragWrite.current < 150) return
    lastDragWrite.current = now
    stickiesY.set(id, { ...data, x: node.x(), y: node.y() })
  }

  const commitEdit = (text: string) => {
    if (editing) {
      const current = stickiesY.get(editing.id)
      if (current) stickiesY.set(editing.id, { ...current, text })
    }
    setEditing(null)
  }

  return (
    <div className="board" ref={containerRef}>
      <div className="board__toolbar">
        {PEN_COLORS.map((color) => (
          <button
            key={color}
            className={color === penColor ? 'board__pen board__pen--active' : 'board__pen'}
            style={{ background: color }}
            onClick={() => setPenColor(color)}
            aria-label={`畫筆 ${color}`}
          />
        ))}
        <button className="board__tool" onClick={addSticky}>
          ＋便利貼
        </button>
        <button className="board__tool" onClick={() => undoManager.undo()}>
          復原
        </button>
        <span className="board__hint">拖曳畫線;便利貼可拖動、雙擊編輯</span>
      </div>
      <Stage
        width={width}
        height={BOARD_HEIGHT}
        className="board__stage"
        onMouseDown={pointerDown}
        onMouseMove={pointerMove}
        onMouseUp={pointerUp}
        onMouseLeave={pointerUp}
        onTouchStart={pointerDown}
        onTouchMove={pointerMove}
        onTouchEnd={pointerUp}
      >
        <Layer>
          {strokes.map((s) => (
            <Line
              key={s.id}
              points={s.points}
              stroke={s.color}
              strokeWidth={s.size}
              lineCap="round"
              lineJoin="round"
              tension={0.4}
            />
          ))}
          {remotes.map(
            (r, i) =>
              r.stroke && (
                <Line
                  key={`remote-stroke-${i}`}
                  points={r.stroke.points}
                  stroke={r.stroke.color}
                  strokeWidth={r.stroke.size}
                  lineCap="round"
                  lineJoin="round"
                  tension={0.4}
                  opacity={0.85}
                />
              ),
          )}
          {drawing.current && (
            <Line
              points={[...drawing.current.points]}
              stroke={drawing.current.color}
              strokeWidth={drawing.current.size}
              lineCap="round"
              lineJoin="round"
              tension={0.4}
            />
          )}
          {stickies.map(([id, s]) => (
            <Group
              key={id}
              x={s.x}
              y={s.y}
              draggable
              onDragMove={(e) => moveSticky(id, s, e.target, false)}
              onDragEnd={(e) => moveSticky(id, s, e.target, true)}
              onDblClick={() => setEditing({ id, x: s.x, y: s.y, text: s.text })}
              onDblTap={() => setEditing({ id, x: s.x, y: s.y, text: s.text })}
            >
              <Rect width={STICKY_W} height={STICKY_H} fill={s.color} cornerRadius={6} shadowBlur={4} shadowOpacity={0.3} />
              <Text text={s.text} x={8} y={8} width={STICKY_W - 16} fontSize={14} fill="#1a1a1a" />
            </Group>
          ))}
          {remotes.map(
            (r, i) =>
              r.cursor && (
                <Group key={`remote-cursor-${i}`} x={r.cursor.x} y={r.cursor.y} listening={false}>
                  <Circle radius={4} fill={r.color} />
                  <Text text={r.name} x={6} y={4} fontSize={11} fill={r.color} />
                </Group>
              ),
          )}
        </Layer>
      </Stage>
      {editing && (
        <textarea
          className="board__edit"
          style={{ left: editing.x, top: editing.y + 40 }}
          defaultValue={editing.text}
          autoFocus
          onBlur={(e) => commitEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitEdit((e.target as HTMLTextAreaElement).value)
            }
            if (e.key === 'Escape') setEditing(null)
          }}
        />
      )}
    </div>
  )
}
