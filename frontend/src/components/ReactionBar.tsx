/** The emoji reactions offered in the toolbar. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏'] as const

interface ReactionBarProps {
  onReact: (emoji: string) => void
  handRaised: boolean
  onToggleHand: () => void
}

/** Toolbar of quick emoji reactions plus a raise-hand toggle. */
export function ReactionBar({ onReact, handRaised, onToggleHand }: ReactionBarProps) {
  return (
    <div className="reactions-bar">
      {REACTIONS.map((emoji) => (
        <button key={emoji} className="reactions-bar__btn" onClick={() => onReact(emoji)} title="送出表情">
          {emoji}
        </button>
      ))}
      <button
        className={handRaised ? 'reactions-bar__hand reactions-bar__hand--on' : 'reactions-bar__hand'}
        onClick={onToggleHand}
        title={handRaised ? '放下手' : '舉手'}
      >
        ✋
      </button>
    </div>
  )
}
