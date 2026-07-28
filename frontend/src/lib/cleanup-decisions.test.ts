import { describe, expect, it } from 'vitest'
import { cleanupDecisionPreview } from './cleanup-decisions'
import type { DashboardInstance } from './types'

const instance = (expiresAt: string): DashboardInstance => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Orders regression',
  purpose: 'Release regression',
  owner: 'Payments QA',
  expiresAt,
  status: 'running',
  environment: 'testing',
  templateName: 'PostgreSQL',
  templateVersion: '17',
  hostName: 'qa-db-01',
  backupCount: 0,
  deleteReady: true,
  blockers: [],
})

describe('cleanupDecisionPreview', () => {
  const now = new Date('2026-07-28T08:00:00.000Z')

  it('extends an expired instance from today', () => {
    expect(cleanupDecisionPreview(instance('2026-07-26T08:00:00.000Z'), 'extend', 7, now).nextExpiresAt)
      .toBe('2026-08-04T08:00:00.000Z')
  })

  it('extends a future instance from its current expiry', () => {
    expect(cleanupDecisionPreview(instance('2026-07-31T08:00:00.000Z'), 'extend', 7, now).nextExpiresAt)
      .toBe('2026-08-07T08:00:00.000Z')
  })

  it('previews indefinite retention without an expiry', () => {
    expect(cleanupDecisionPreview(instance('2026-07-31T08:00:00.000Z'), 'retain', 0, now).nextExpiresAt)
      .toBeUndefined()
  })
})
