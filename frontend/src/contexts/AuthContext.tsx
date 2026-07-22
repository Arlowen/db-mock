import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import i18n from '../i18n'
import { api, sessionInvalidatedEvent } from '../lib/api'
import { applyLocale, normalizeLocale, type AppLocale } from '../lib/locale'
import type { User } from '../lib/types'

interface AuthState {
  loading: boolean
  initialized: boolean
  user: User | null
  sessionExpired: boolean
  login: (username: string, password: string) => Promise<void>
  setup: (values: { username: string; password: string; displayName: string; locale: string }) => Promise<void>
  logout: () => Promise<void>
  reload: () => Promise<void>
  updateLocale: (locale: AppLocale) => Promise<void>
  updateProfile: (values: { displayName: string; locale: AppLocale }) => Promise<void>
  changePassword: (values: { currentPassword: string; newPassword: string }) => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [initialized, setInitialized] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const userRef = useRef<User | null>(null)
  userRef.current = user

  useEffect(() => {
    const invalidateSession = () => {
      if (userRef.current) setSessionExpired(true)
      setUser(null)
    }
    window.addEventListener(sessionInvalidatedEvent, invalidateSession)
    return () => window.removeEventListener(sessionInvalidatedEvent, invalidateSession)
  }, [])

  const reload = useCallback(async () => {
    try {
      const setupStatus = await api<{ initialized: boolean }>('/setup/status')
      setInitialized(setupStatus.initialized)
      if (setupStatus.initialized) {
        const me = await api<{ user: User }>('/auth/me')
        await applyLocale(me.user.locale)
        setSessionExpired(false)
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
    setSessionExpired(false)
    setUser(response.user)
  }
  const setup = async (values: { username: string; password: string; displayName: string; locale: string }) => {
    const response = await api<{ user: User }>('/setup', { method: 'POST', body: values })
    await applyLocale(response.user.locale)
    setInitialized(true)
    setSessionExpired(false)
    setUser(response.user)
  }
  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} })
    setSessionExpired(false)
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
  const updateProfile = useCallback(async (values: { displayName: string; locale: AppLocale }) => {
    const response = await api<{ user: User }>('/auth/me', { method: 'PATCH', body: values })
    await applyLocale(response.user.locale)
    setUser(response.user)
  }, [])
  const changePassword = useCallback(async (values: { currentPassword: string; newPassword: string }) => {
    await api('/auth/password', { method: 'PUT', body: values })
  }, [])
  const value = useMemo(() => ({ loading, initialized, user, sessionExpired, login, setup, logout, reload, updateLocale, updateProfile, changePassword }), [loading, initialized, user, sessionExpired, reload, updateLocale, updateProfile, changePassword])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is missing')
  return value
}
