import type { User, UserRole } from './types'

export interface UserPermissions {
  role: UserRole
  canOperate: boolean
  canReadCredentials: boolean
  canViewAudit: boolean
  canManageUsers: boolean
  canManageSettings: boolean
}

export function permissionsFor(user: Pick<User, 'role'>): UserPermissions {
  const canOperate = user.role === 'admin' || user.role === 'operator'
  return {
    role: user.role,
    canOperate,
    canReadCredentials: canOperate,
    canViewAudit: canOperate,
    canManageUsers: user.role === 'admin',
    canManageSettings: user.role === 'admin',
  }
}
