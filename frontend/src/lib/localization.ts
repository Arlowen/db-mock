import type { TFunction } from 'i18next'
import { defaultTimezone, normalizeTimezone } from './timezone'

function keyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

export function translateCode(t: TFunction, value: string, prefix = ''): string {
  if (!value) return '—'
  const normalized = keyPart(value)
  const key = prefix ? `${prefix}_${normalized}` : normalized
  return t(key, { defaultValue: value.replaceAll('_', ' ').replaceAll('.', ' ') })
}

function format(value: string | Date | undefined, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: normalizeTimezone(timeZone) }).format(date)
}

export function formatDateTime(value: string | undefined, locale: string, timeZone = defaultTimezone): string {
  return format(value, locale, timeZone, { dateStyle: 'medium', timeStyle: 'medium' })
}

export function formatCompactDateTime(value: string | undefined, locale: string, timeZone = defaultTimezone): string {
  return format(value, locale, timeZone, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatTime(value: string | Date | undefined, locale: string, timeZone = defaultTimezone): string {
  return format(value, locale, timeZone, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
