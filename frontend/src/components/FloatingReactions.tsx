export interface FloatingReaction {
  id: string
  emoji: string
  /** Horizontal position as a percentage, so simultaneous reactions don't stack. */
  left: number
}

interface FloatingReactionsProps {
  reactions: FloatingReaction[]
}

/** Overlay of emoji that float up and fade; purely presentational. */
export function FloatingReactions({ reactions }: FloatingReactionsProps) {
  return (
    <div className="floating-reactions" aria-hidden>
      {reactions.map((r) => (
        <span key={r.id} className="floating-reactions__item" style={{ left: `${r.left}%` }}>
          {r.emoji}
        </span>
      ))}
    </div>
  )
}
