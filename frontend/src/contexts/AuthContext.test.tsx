import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider, useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { AuthProvider, useAuth } from './AuthContext'

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: 'Admin',
  locale: 'en-US',
  createdAt: '2026-01-01T00:00:00Z',
}

function LocaleProbe() {
  const { i18n: active } = useTranslation()
  const { loading, user, updateLocale } = useAuth()
  const target = active.language === 'en-US' ? 'zh-CN' : 'en-US'
  const [failed, setFailed] = useState(false)
  if (loading) return <span>loading</span>
  return <><button onClick={() => void updateLocale(target).catch(() => setFailed(true))}>{active.language}:{user?.locale}</button>{failed && <span>failed</span>}</>
}

function renderProvider() {
  return render(<I18nextProvider i18n={i18n}><AuthProvider><LocaleProbe /></AuthProvider></I18nextProvider>)
}

describe('account language preference', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('zh-CN')
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('adopts the signed-in account locale and persists a change', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/setup/status')) return Response.json({ initialized: true })
      if (path.endsWith('/auth/me') && init?.method === 'PATCH') return Response.json({ user: { ...account, locale: 'zh-CN' } })
      if (path.endsWith('/auth/me')) return Response.json({ user: account })
      throw new Error(`Unexpected request: ${path}`)
    })

    renderProvider()
    const button = await screen.findByRole('button', { name: 'en-US:en-US' })
    expect(localStorage.getItem('dbmock-locale')).toBe('en-US')

    fireEvent.click(button)

    await screen.findByRole('button', { name: 'zh-CN:zh-CN' })
    expect(localStorage.getItem('dbmock-locale')).toBe('zh-CN')
    const request = vi.mocked(globalThis.fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(request?.[1]?.body).toBe(JSON.stringify({ locale: 'zh-CN' }))
  })

  it('rolls the interface back when the preference cannot be saved', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/setup/status')) return Response.json({ initialized: true })
      if (path.endsWith('/auth/me') && init?.method === 'PATCH') {
        return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 })
      }
      if (path.endsWith('/auth/me')) return Response.json({ user: account })
      throw new Error(`Unexpected request: ${path}`)
    })

    renderProvider()
    fireEvent.click(await screen.findByRole('button', { name: 'en-US:en-US' }))

    await screen.findByText('failed')
    await waitFor(() => expect(screen.getByRole('button', { name: 'en-US:en-US' })).toBeInTheDocument())
    expect(localStorage.getItem('dbmock-locale')).toBe('en-US')
  })
})
