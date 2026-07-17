import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { User } from '../lib/types'

interface AuthState {
  loading: boolean
  initialized: boolean
  user: User | null
  login: (username: string, password: string) => Promise<void>
  setup: (values: { username: string; password: string; displayName: string; locale: string }) => Promise<void>
  logout: () => Promise<void>
  reload: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [initialized, setInitialized] = useState(true)
  const [user, setUser] = useState<User | null>(null)

  const reload = useCallback(async () => {
    try {
      const setupStatus = await api<{ initialized: boolean }>('/setup/status')
      setInitialized(setupStatus.initialized)
      if (setupStatus.initialized) {
        const me = await api<{ user: User }>('/auth/me')
        setUser(me.user)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const login = async (username: string, password: string) => {
    const response = await api<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } })
    setUser(response.user)
  }
  const setup = async (values: { username: string; password: string; displayName: string; locale: string }) => {
    const response = await api<{ user: User }>('/setup', { method: 'POST', body: values })
    setInitialized(true)
    setUser(response.user)
  }
  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} })
    setUser(null)
  }
  const value = useMemo(() => ({ loading, initialized, user, login, setup, logout, reload }), [loading, initialized, user, reload])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is missing')
  return value
}
