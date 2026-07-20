export const defaultTimezone = 'Asia/Shanghai'

export const commonTimezones = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
]

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || value.trim() === 'Local') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format()
    return true
  } catch {
    return false
  }
}

export function normalizeTimezone(value: unknown, fallback = defaultTimezone): string {
  if (isValidTimezone(value)) return value.trim()
  return isValidTimezone(fallback) ? fallback.trim() : defaultTimezone
}
