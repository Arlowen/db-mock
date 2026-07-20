import { describe, expect, it } from 'vitest'
import { formatDateTime, formatTime } from './localization'

describe('localized timestamps', () => {
  it('uses the configured system timezone instead of the browser timezone', () => {
    const instant = '2026-01-01T00:00:00Z'
    expect(formatDateTime(instant, 'en-US', 'UTC')).toContain('Jan 1, 2026')
    expect(formatDateTime(instant, 'en-US', 'America/New_York')).toContain('Dec 31, 2025')
    expect(formatTime(instant, 'en-US', 'Asia/Shanghai')).toContain('08:00:00')
  })

  it('renders missing or invalid timestamps safely', () => {
    expect(formatDateTime(undefined, 'en-US', 'UTC')).toBe('—')
    expect(formatDateTime('not-a-date', 'en-US', 'UTC')).toBe('—')
  })
})
