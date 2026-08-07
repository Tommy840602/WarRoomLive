import type { Theme, ThemePreference } from '../theme/theme'

interface ThemeToggleProps {
  theme: Theme
  preference: ThemePreference
  onChange: (next: ThemePreference) => void
}

const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'auto', label: '自動', hint: '跟著本地時間切換' },
  { value: 'day', label: '日', hint: '固定日間配色' },
  { value: 'night', label: '夜', hint: '固定夜間配色' },
]

/**
 * Which skin the room is wearing, and whether that is the clock's decision.
 *
 * The override exists because "follow the clock" is a good default and a bad
 * rule: someone presenting to a projector at 9pm needs the day skin, and the
 * clock has no way to know that.
 */
export function ThemeToggle({ theme, preference, onChange }: ThemeToggleProps) {
  return (
    <div
      className="skin"
      role="group"
      aria-label={`配色(目前${theme === 'day' ? '日間' : '夜間'})`}
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="skin__btn"
          aria-pressed={preference === option.value}
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {/* On auto, show which way the clock went — otherwise "自動" tells you
              the mode but not the answer. */}
          {option.value === 'auto' && preference === 'auto' && (
            <span className="skin__resolved" aria-hidden="true">
              {theme === 'day' ? '☀' : '☾'}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
