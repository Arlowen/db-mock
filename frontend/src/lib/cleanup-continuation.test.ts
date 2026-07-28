import { describe, expect, it } from 'vitest'
import { cleanupContinuationPhase, cleanupEvidenceState, hasActiveBackupOperation } from './cleanup-continuation'

describe('cleanup continuation', () => {
  it('never treats unknown backup or task evidence as safe to delete', () => {
    expect(cleanupEvidenceState('ready', 'error')).toBe('error')
    expect(cleanupEvidenceState('ready', 'loading')).toBe('loading')
    expect(cleanupEvidenceState('ready', 'ready')).toBe('ready')
    expect(cleanupContinuationPhase({
      evidenceState: 'loading',
      backupStatuses: [],
      hasActiveTask: false,
    })).toBe('loading')
    expect(cleanupContinuationPhase({
      evidenceState: 'error',
      backupStatuses: [],
      hasActiveTask: false,
    })).toBe('unavailable')
  })

  it('waits for active instance and backup operations', () => {
    expect(cleanupContinuationPhase({
      evidenceState: 'ready',
      backupStatuses: [],
      hasActiveTask: true,
    })).toBe('processing')
    expect(cleanupContinuationPhase({
      evidenceState: 'ready',
      backupStatuses: ['deleting'],
      hasActiveTask: false,
    })).toBe('processing')
    expect(hasActiveBackupOperation(['ready', 'creating'])).toBe(true)
  })

  it('keeps remaining backups blocked and only continues from an authoritative empty inventory', () => {
    expect(cleanupContinuationPhase({
      evidenceState: 'ready',
      backupStatuses: ['ready'],
      hasActiveTask: false,
      failedBackupDeleteCount: 1,
    })).toBe('failed')
    expect(cleanupContinuationPhase({
      evidenceState: 'ready',
      backupStatuses: ['ready', 'failed'],
      hasActiveTask: false,
    })).toBe('blocked')
    expect(cleanupContinuationPhase({
      evidenceState: 'ready',
      backupStatuses: [],
      hasActiveTask: false,
    })).toBe('ready')
  })
})
