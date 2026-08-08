interface MentionPickerProps {
  /** Names to offer, already filtered and ordered. */
  options: string[]
  /** Index of the one the keyboard is on. */
  active: number
  onPick: (name: string) => void
  onHover: (index: number) => void
  /** Ties the input's aria-activedescendant to the highlighted option. */
  idPrefix: string
}

/**
 * The list of people an `@` could mean.
 *
 * Deliberately a suggestion and not a constraint: the field stays free text, so
 * a task can belong to somebody who has never opened this app. The room is
 * offered because that is who it usually is, not because it is who it must be —
 * a picker that refused an unknown name would make the common case faster and
 * the real case impossible.
 *
 * `listbox` rather than a menu, and the input keeps focus throughout: this is a
 * combobox, and moving focus into the list would take the caret out of the line
 * somebody is in the middle of typing.
 */
export function MentionPicker({ options, active, onPick, onHover, idPrefix }: MentionPickerProps) {
  if (options.length === 0) return null

  return (
    <ul className="mention" role="listbox" id={`${idPrefix}-list`} aria-label="房間成員">
      {options.map((name, index) => (
        <li
          key={name}
          id={`${idPrefix}-option-${index}`}
          className={`mention__option${index === active ? ' mention__option--active' : ''}`}
          role="option"
          aria-selected={index === active}
          // Pointer-down rather than click: a click fires after blur, and the
          // blur would have closed this before the pick landed.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(name)
          }}
          onMouseEnter={() => onHover(index)}
        >
          <span className="mention__at" aria-hidden="true">
            @
          </span>
          {name}
        </li>
      ))}
    </ul>
  )
}
