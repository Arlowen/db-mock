import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { AuthProvider } from './AuthContext'
import { SystemSettingsProvider, useSystemSettings } from './SystemSettingsContext'

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: 'Admin',
  locale: 'en-US',
  createdAt: '2026-01-01T00:00:00Z',
}

function Probe() {
  const { timezone } = useSystemSettings()
  return <span>{timezone}</span>
}

describe('system settings context', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('loads the persisted timezone after authentication', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/setup/status')) return Response.json({ initialized: true })
      if (path.endsWith('/auth/me')) return Response.json({ user: account })
      if (path.endsWith('/settings')) return Response.json({ timezone: 'America/New_York' })
      throw new Error(`Unexpected request: ${path}`)
    })

    render(<I18nextProvider i18n={i18n}><AuthProvider><SystemSettingsProvider><Probe /></SystemSettingsProvider></AuthProvider></I18nextProvider>)

    expect(await screen.findByText('America/New_York')).toBeInTheDocument()
  })
})
