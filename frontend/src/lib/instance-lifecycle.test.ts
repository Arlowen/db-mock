import { describe, expect, it } from 'vitest'
import { instanceLifecycleState, lifecycleCounts } from './instance-lifecycle'

const now = new Date('2026-07-27T08:00:00Z').getTime()

describe('instanceLifecycleState', () => {
  it('distinguishes retained, scheduled, due-soon, and expired instances', () => {
    expect(instanceLifecycleState(undefined, now)).toBe('retained')
    expect(instanceLifecycleState('2026-08-20T08:00:00Z', now)).toBe('scheduled')
    expect(instanceLifecycleState('2026-08-01T08:00:00Z', now)).toBe('dueSoon')
    expect(instanceLifecycleState('2026-07-27T07:59:59Z', now)).toBe('expired')
  })

  it('counts only actionable lifecycle states', () => {
    expect(lifecycleCounts([
      { expiresAt: '2026-07-26T08:00:00Z' },
      { expiresAt: '2026-07-30T08:00:00Z' },
      { expiresAt: '2026-08-20T08:00:00Z' },
    ], now)).toEqual({ expired: 1, dueSoon: 1 })
  })
})
