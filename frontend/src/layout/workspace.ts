/**
 * How the workspace is divided, and how big the video tiles are.
 *
 * Both are the user's, not the layout's. A room watching one person present
 * wants the video large; a room working through the agenda wants the panel wide
 * enough to be a real week view; and neither is a default the app can guess
 * from the outside. So both are stored, per browser — this is a preference
 * about *this screen*, not a decision the room makes together, which is the
 * opposite of how triage works and for the opposite reason.
 */

export const SIDEBAR_KEY = 'warroomlive.sidebar'
export const TILE_KEY = 'warroomlive.tile'

/**
 * Bounds on the side panel.
 *
 * The floor is where the capture line and a chat message stop being readable;
 * the ceiling leaves room for the video to still be video rather than a strip.
 */
export const SIDEBAR_MIN = 260
export const SIDEBAR_MAX = 900
export const SIDEBAR_DEFAULT = 320

/** Tile sizes, as the grid's minimum column width. */
export const TILE_STEPS = [180, 240, 320, 440, 620] as const
export const TILE_DEFAULT = 240

export function clampSidebar(px: number, available = Infinity): number {
  // Never wider than the workspace can spare: dragging past the edge would
  // leave the video column at zero and the divider unreachable.
  const ceiling = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, available - SIDEBAR_MIN))
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(px, ceiling)))
}

/** Snaps to the nearest offered size, so a stored oddity cannot wedge the control. */
export function clampTile(px: number): number {
  return TILE_STEPS.reduce((best, step) =>
    Math.abs(step - px) < Math.abs(best - px) ? step : best,
  )
}

export function stepTile(current: number, by: 1 | -1): number {
  const index = TILE_STEPS.indexOf(clampTile(current) as (typeof TILE_STEPS)[number])
  return TILE_STEPS[Math.max(0, Math.min(TILE_STEPS.length - 1, index + by))]
}

/**
 * Reads a stored number, falling back on anything unusable.
 *
 * A corrupt or hand-edited value must not be able to leave the workspace in a
 * state the user cannot drag their way out of.
 */
export function readNumber(storage: Pick<Storage, 'getItem'>, key: string, fallback: number): number {
  try {
    const raw = storage.getItem(key)
    // Blank is missing, not zero: `Number('')` is 0, which is finite and would
    // sail through the check below as a perfectly good width of nothing.
    if (raw === null || raw.trim() === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
  } catch {
    // Private browsing refuses reads; the default is a fine answer.
    return fallback
  }
}

export function writeNumber(storage: Pick<Storage, 'setItem'>, key: string, value: number): void {
  try {
    storage.setItem(key, String(value))
  } catch {
    // The choice still holds for this session.
  }
}
