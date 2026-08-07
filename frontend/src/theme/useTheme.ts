import { useCallback, useEffect, useState } from 'react'
import {
  THEME_STORAGE_KEY,
  msUntilNextSwitch,
  readPreference,
  resolveTheme,
  type Theme,
  type ThemePreference,
} from './theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Applies the room's skin to the document and keeps it current.
 *
 * Three things can change the answer while a room is open — the clock crossing
 * dawn or dusk, the OS switching its own scheme, and the user overriding — so
 * all three are listened to. The timer aims at the next boundary rather than
 * polling, because the clock only has an opinion twice a day.
 */
export function useTheme(): {
  theme: Theme
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof localStorage === 'undefined' ? 'auto' : readPreference(localStorage),
  )
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(preference, new Date(), prefersDark()),
  )

  useEffect(() => {
    let timer: number | undefined

    const apply = () => {
      setTheme(resolveTheme(preference, new Date(), prefersDark()))
      window.clearTimeout(timer)
      // Only the clock needs waking; an explicit choice never expires.
      if (preference === 'auto') {
        timer = window.setTimeout(apply, msUntilNextSwitch(new Date()))
      }
    }
    apply()

    const media = window.matchMedia?.(DARK_QUERY)
    media?.addEventListener('change', apply)
    // A laptop asleep through dusk wakes with a timer that never fired.
    document.addEventListener('visibilitychange', apply)

    return () => {
      window.clearTimeout(timer)
      media?.removeEventListener('change', apply)
      document.removeEventListener('visibilitychange', apply)
    }
  }, [preference])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    // Tells the browser which scrollbars and form controls to draw.
    document.documentElement.style.colorScheme = theme === 'night' ? 'dark' : 'light'
  }, [theme])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Private browsing refuses writes; the choice still holds for this session.
    }
  }, [])

  return { theme, preference, setPreference }
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(DARK_QUERY).matches
    : false
}
