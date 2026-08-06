import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts'

/** Auth bootstrap served by the backend; `enabled: false` means open mode. */
interface AuthConfig {
  enabled: boolean
  issuer: string
  clientId: string
}

export interface AuthState {
  /** Bearer token to attach to signaling/collab connections; null in open mode. */
  token: string | null
  /** Display name from the identity provider; null in open mode. */
  displayName: string | null
}

const AuthContext = createContext<AuthState>({ token: null, displayName: null })
export const useAuth = () => useContext(AuthContext)

async function fetchAuthConfig(): Promise<AuthConfig> {
  try {
    const res = await fetch('/api/auth/config')
    if (!res.ok) throw new Error(`auth config: HTTP ${res.status}`)
    return (await res.json()) as AuthConfig
  } catch {
    // Backend without the endpoint (or unreachable) behaves like open mode; actual
    // enforcement is server-side, so failing open here grants nothing.
    return { enabled: false, issuer: '', clientId: '' }
  }
}

/**
 * Gates the app behind OIDC login when the backend requires it (`oidc` profile).
 * Handles the PKCE redirect callback, keeps the session in sessionStorage, and
 * exposes the access token + display name via {@link useAuth}. In open mode it
 * renders children untouched.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<'loading' | 'login' | 'ready'>('loading')
  const [auth, setAuth] = useState<AuthState>({ token: null, displayName: null })
  const [error, setError] = useState<string | null>(null)
  const managerRef = useRef<UserManager | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const config = await fetchAuthConfig()
      if (cancelled) return
      if (!config.enabled) {
        setPhase('ready')
        return
      }
      const manager = new UserManager({
        authority: config.issuer,
        client_id: config.clientId,
        redirect_uri: window.location.origin + window.location.pathname,
        response_type: 'code',
        scope: 'openid profile',
        loadUserInfo: false,
        automaticSilentRenew: false,
        userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      })
      managerRef.current = manager

      const apply = (user: User) => {
        setAuth({
          token: user.access_token,
          displayName:
            (user.profile.preferred_username as string | undefined) ?? user.profile.sub,
        })
        setPhase('ready')
      }

      const params = new URLSearchParams(window.location.search)
      try {
        if (params.has('code') && params.has('state')) {
          const user = await manager.signinRedirectCallback()
          window.history.replaceState({}, '', window.location.pathname)
          if (!cancelled) apply(user)
          return
        }
        const existing = await manager.getUser()
        if (!cancelled && existing && !existing.expired) {
          apply(existing)
          return
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      if (!cancelled) setPhase('login')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (phase === 'loading') {
    return (
      <main className="app auth">
        <p className="auth__status">檢查登入狀態…</p>
      </main>
    )
  }

  if (phase === 'login') {
    return (
      <main className="app auth">
        <h1>WarRoomLive</h1>
        <p className="app__subtitle">低延遲跨部門協作討論室</p>
        {error && <p className="app__error">⚠️ 登入失敗:{error}</p>}
        <p>此環境需要登入後才能加入房間。</p>
        <button onClick={() => void managerRef.current?.signinRedirect()}>登入</button>
      </main>
    )
  }

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}
