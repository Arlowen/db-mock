import { describe, expect, it } from 'vitest'
import { displayNameReady, passwordReady, userDraftChanged, userFormReady, usernameReady } from './user-form'

describe('user form readiness', () => {
  it('requires a valid new account identity and password', () => {
    expect(userFormReady({ username: '', displayName: '', password: '', locale: 'zh-CN', role: 'viewer' }, false, true)).toBe(false)
    expect(userFormReady({ username: 'qa user', displayName: 'QA', password: 'strong-pass', locale: 'zh-CN', role: 'viewer' }, false, true)).toBe(false)
    expect(userFormReady({ username: 'qa.user', displayName: ' QA ', password: 'strong-pass', locale: 'zh-CN', role: 'viewer' }, false, true)).toBe(true)
  })

  it('allows an empty password when editing but rejects an incomplete replacement', () => {
    const values = { displayName: 'Admin', password: '', locale: 'zh-CN', role: 'admin' as const }
    expect(userFormReady(values, true, false)).toBe(false)
    expect(userFormReady(values, true, true)).toBe(true)
    expect(userFormReady({ ...values, password: 'short' }, true, true)).toBe(false)
  })

  it('treats trimmed text restored to its baseline as unchanged', () => {
    const baseline = { displayName: 'Admin', password: '', locale: 'zh-CN', role: 'admin' as const, disabled: false }
    expect(userDraftChanged({ ...baseline, displayName: '  Admin  ' }, baseline)).toBe(false)
    expect(userDraftChanged({ ...baseline, displayName: 'Administrator' }, baseline)).toBe(true)
  })

  it('enforces the visible field limits', () => {
    expect(usernameReady('ab')).toBe(false)
    expect(usernameReady('ops_admin-1')).toBe(true)
    expect(usernameReady('ops admin')).toBe(false)
    expect(displayNameReady('   ')).toBe(false)
    expect(passwordReady('1234567')).toBe(false)
    expect(passwordReady('12345678')).toBe(true)
  })
})
