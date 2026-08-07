/**
 * Which of the room's two skins is showing, and why.
 *
 * The premise: a war room at 3am and the same room at 2pm are not the same
 * place, so this is not a "dark mode" preference sitting in settings — it is
 * the room's own clock. The browser's clock is the user's timezone, which is
 * the whole mechanism; nothing here needs a location or an API.
 */

export type Theme = 'day' | 'night'

/** What the user asked for. `auto` means "follow the room's clock". */
export type ThemePreference = 'auto' | Theme

/** Local hour the day skin takes over, inclusive. */
export const DAY_FROM_HOUR = 7
/** Local hour the night skin takes over, inclusive. */
export const NIGHT_FROM_HOUR = 19

export const THEME_STORAGE_KEY = 'warroomlive.theme'

/**
 * Resolves the skin to show.
 *
 * An explicit choice always wins. Failing that, note the asymmetry in
 * `prefersDark`: a browser reports `prefers-color-scheme: light` when the user
 * has said nothing at all, so light cannot be read as a statement — but dark is
 * something a person had to go and turn on, often for a reason as real as light
 * sensitivity. So a dark OS preference overrides the clock, and a light one
 * defers to it.
 */
export function resolveTheme(
  preference: ThemePreference,
  now: Date,
  prefersDark: boolean,
): Theme {
  if (preference !== 'auto') return preference
  if (prefersDark) return 'night'
  return themeForHour(now.getHours())
}

export function themeForHour(hour: number): Theme {
  return hour >= DAY_FROM_HOUR && hour < NIGHT_FROM_HOUR ? 'day' : 'night'
}

/**
 * Milliseconds until the clock would next flip the skin.
 *
 * A room stays open for hours, so the switch has to happen under the user
 * rather than at the next page load. Waking exactly at the boundary beats
 * polling every minute for a change that happens twice a day.
 */
export function msUntilNextSwitch(now: Date): number {
  const next = new Date(now)
  next.setMinutes(0, 0, 0)
  const hour = now.getHours()
  next.setHours(hour < DAY_FROM_HOUR ? DAY_FROM_HOUR : hour < NIGHT_FROM_HOUR ? NIGHT_FROM_HOUR : 24)
  return Math.max(next.getTime() - now.getTime(), 1000)
}

export function readPreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  const stored = storage.getItem(THEME_STORAGE_KEY)
  return stored === 'day' || stored === 'night' || stored === 'auto' ? stored : 'auto'
}
