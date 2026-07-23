import type { UserRole } from './types'

export interface UserFormValues {
  username?: string
  displayName?: string
  password?: string
  locale?: string
  role?: UserRole
  disabled?: boolean
}

export const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const draftFields: Array<keyof UserFormValues> = ['username', 'displayName', 'password', 'locale', 'role', 'disabled']

export function usernameReady(value?: string) {
  const username = value?.trim() || ''
  return username.length >= 3 && username.length <= 64 && usernamePattern.test(username)
}

export function displayNameReady(value?: string) {
  const displayName = value?.trim() || ''
  return displayName.length >= 1 && displayName.length <= 100
}

export function passwordReady(value?: string) {
  const password = value || ''
  return password.length >= 8 && password.length <= 128
}

function normalizedDraftValue(values: UserFormValues, key: keyof UserFormValues) {
  const value = values[key]
  if (key === 'username' || key === 'displayName') return String(value || '').trim()
  if (key === 'disabled') return !!value
  return value || ''
}

export function userDraftChanged(values: UserFormValues, baseline: UserFormValues | null) {
  if (!baseline) return true
  return draftFields.some(
    (key) => normalizedDraftValue(values, key) !== normalizedDraftValue(baseline, key),
  )
}

export function userFormReady(values: UserFormValues, editing: boolean, dirty: boolean) {
  if (!displayNameReady(values.displayName) || !values.locale || !values.role) return false
  if (!editing && (!usernameReady(values.username) || !passwordReady(values.password))) return false
  if (editing && values.password && !passwordReady(values.password)) return false
  return !editing || dirty
}
