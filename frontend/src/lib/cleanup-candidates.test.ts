import { describe, expect, it } from 'vitest'
import { cleanupCandidateCounts, cleanupCandidateMissingContext, filterCleanupCandidates } from './cleanup-candidates'
import type { DashboardInstance } from './types'

const candidate = (overrides: Partial<DashboardInstance> = {}): DashboardInstance => ({
  id: 'instance-id',
  name: 'Orders PostgreSQL',
  purpose: 'Release regression',
  owner: 'Platform QA',
  expiresAt: '2026-07-29T00:00:00Z',
  status: 'stopped',
  environment: 'testing',
  templateName: 'PostgreSQL',
  templateVersion: '17',
  hostName: 'test-host',
  backupCount: 0,
  deleteReady: true,
  blockers: [],
  ...overrides,
})

describe('cleanup candidate triage', () => {
  it('separates ready and blocked candidates while counting missing handoff context', () => {
    const items = [
      candidate(),
      candidate({ id: 'blocked', backupCount: 2, deleteReady: false, blockers: ['backups_present'] }),
      candidate({ id: 'missing', owner: '' }),
    ]

    expect(cleanupCandidateCounts(items)).toEqual({ all: 3, ready: 2, blocked: 1, missingContext: 1 })
    expect(filterCleanupCandidates(items, 'ready').map((item) => item.id)).toEqual(['instance-id', 'missing'])
    expect(filterCleanupCandidates(items, 'blocked').map((item) => item.id)).toEqual(['blocked'])
  })

  it('treats blank purpose or owner as missing cleanup context', () => {
    expect(cleanupCandidateMissingContext(candidate({ purpose: '   ' }))).toBe(true)
    expect(cleanupCandidateMissingContext(candidate({ owner: '' }))).toBe(true)
    expect(cleanupCandidateMissingContext(candidate())).toBe(false)
  })
})
