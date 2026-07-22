import { describe, expect, it } from 'vitest'
import { permissionsFor } from './permissions'

describe('role permissions', () => {
  it('keeps administration separate from daily operations', () => {
    expect(permissionsFor({ role: 'admin' })).toMatchObject({ canOperate: true, canManageUsers: true, canManageSettings: true })
    expect(permissionsFor({ role: 'operator' })).toMatchObject({ canOperate: true, canManageUsers: false, canManageSettings: false, canReadCredentials: true })
  })

  it('makes viewers read-only and hides credentials', () => {
    expect(permissionsFor({ role: 'viewer' })).toMatchObject({ canOperate: false, canReadCredentials: false, canViewAudit: false })
  })
})
