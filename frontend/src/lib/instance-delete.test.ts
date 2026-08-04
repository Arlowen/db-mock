import { describe, expect, it } from 'vitest'
import { canSubmitInstanceDelete, instanceDeleteEvidence } from './instance-delete'
import type { InstanceCleanupReview } from './types'

const readyReview: InstanceCleanupReview = {
  instanceId: 'instance-1',
  instanceName: 'orders_test',
  status: 'stopped',
  purpose: '',
  owner: '',
  backupCount: 0,
  deleteReady: true,
  blockers: [],
}

describe('instance delete safety', () => {
  it('separates loading, unavailable, blocked, and ready evidence', () => {
    expect(instanceDeleteEvidence(undefined, true, '')).toBe('loading')
    expect(instanceDeleteEvidence(undefined, false, 'offline')).toBe('error')
    expect(instanceDeleteEvidence({ ...readyReview, deleteReady: false, backupCount: 1, blockers: ['backups_present'] }, false, '')).toBe('blocked')
    expect(instanceDeleteEvidence(readyReview, false, '')).toBe('ready')
  })

  it('requires exact confirmation and fresh delete evidence', () => {
    expect(canSubmitInstanceDelete({ review: readyReview, confirmation: 'orders_test', submitting: false, needsRefresh: false })).toBe(true)
    expect(canSubmitInstanceDelete({ review: readyReview, confirmation: 'orders', submitting: false, needsRefresh: false })).toBe(false)
    expect(canSubmitInstanceDelete({ review: readyReview, confirmation: 'orders_test', submitting: false, needsRefresh: true })).toBe(false)
    expect(canSubmitInstanceDelete({ review: readyReview, confirmation: 'orders_test', submitting: true, needsRefresh: false })).toBe(false)
  })
})
