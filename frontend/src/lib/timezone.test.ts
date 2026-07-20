import { describe, expect, it } from 'vitest'
import { defaultTimezone, isValidTimezone, normalizeTimezone } from './timezone'

describe('timezone settings', () => {
  it('accepts IANA timezone names and trims stored values', () => {
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(normalizeTimezone(' Asia/Shanghai ')).toBe('Asia/Shanghai')
  })

  it('rejects host-local and unknown timezone names', () => {
    expect(isValidTimezone('Local')).toBe(false)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
    expect(normalizeTimezone('invalid')).toBe(defaultTimezone)
  })
})
