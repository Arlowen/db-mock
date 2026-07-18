import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import i18n from '../i18n'
import { api } from '../lib/api'
import { applyLocale, normalizeLocale, type AppLocale } from '../lib/locale'
import type { User } from '../lib/types'

interface AuthState {
  loading: boolean
  initialized: boolean
  user: User | null
  login: (username: string, password: string) => Promise<void>
  setup: (values: { username: string; password: string; displayName: string; locale: string }) => Promise<void>
  logout: () => Promise<void>
  reload: () => Promise<void>
  updateLocale: (locale: AppLocale) => Promise<void>
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
        await applyLocale(me.user.locale)
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
    await applyLocale(response.user.locale)
    setUser(response.user)
  }
  const setup = async (values: { username: string; password: string; displayName: string; locale: string }) => {
    const response = await api<{ user: User }>('/setup', { method: 'POST', body: values })
    await applyLocale(response.user.locale)
    setInitialized(true)
    setUser(response.user)
  }
  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} })
    setUser(null)
  }
  const updateLocale = useCallback(async (requested: AppLocale) => {
    if (!user) return
    const previous = normalizeLocale(i18n.language)
    await applyLocale(requested)
    try {
      const response = await api<{ user: User }>('/auth/me', { method: 'PATCH', body: { locale: requested } })
      setUser(response.user)
    } catch (error) {
      await applyLocale(previous)
      throw error
    }
  }, [user])
  const value = useMemo(() => ({ loading, initialized, user, login, setup, logout, reload, updateLocale }), [loading, initialized, user, reload, updateLocale])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is missing')
  return value
}
