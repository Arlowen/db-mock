import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { api } from '../lib/api'
import { defaultTimezone, normalizeTimezone } from '../lib/timezone'

interface SystemSettingsState {
  loading: boolean
  timezone: string
  reload: () => Promise<void>
}

const SystemSettingsContext = createContext<SystemSettingsState | null>(null)

export function SystemSettingsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [timezone, setTimezone] = useState(defaultTimezone)
  const [loadedUserID, setLoadedUserID] = useState('')

  const reload = useCallback(async () => {
    if (!user) {
      setTimezone(defaultTimezone)
      setLoadedUserID('')
      return
    }
    try {
      const settings = await api<Record<string, unknown>>('/settings')
      setTimezone(normalizeTimezone(settings.timezone))
    } finally {
      setLoadedUserID(user.id)
    }
  }, [user])

  useEffect(() => {
    void reload().catch(() => setTimezone(defaultTimezone))
  }, [reload])

  const loading = !!user && loadedUserID !== user.id
  const value = useMemo(() => ({ loading, timezone, reload }), [loading, reload, timezone])
  return <SystemSettingsContext.Provider value={value}>{children}</SystemSettingsContext.Provider>
}

export function useSystemSettings() {
  const value = useContext(SystemSettingsContext)
  if (!value) throw new Error('SystemSettingsProvider is missing')
  return value
}
