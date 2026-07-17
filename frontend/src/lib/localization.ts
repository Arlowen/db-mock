import type { TFunction } from 'i18next'

function keyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

export function translateCode(t: TFunction, value: string, prefix = ''): string {
  if (!value) return '—'
  const normalized = keyPart(value)
  const key = prefix ? `${prefix}_${normalized}` : normalized
  return t(key, { defaultValue: value.replaceAll('_', ' ').replaceAll('.', ' ') })
}

export function formatDateTime(value: string | undefined, locale: string): string {
  return value ? new Date(value).toLocaleString(locale) : '—'
}
