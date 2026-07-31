import { describe, expect, it } from 'vitest'
import { backupRequestRecoveryKey, canRetryBackupRequest } from './backup-request-recovery'

describe('backup request recovery', () => {
  it('retries creation only from a stable source state without an active operation', () => {
    expect(canRetryBackupRequest({
      action: 'create', instanceStatus: 'running', hasActiveOperation: false,
    })).toBe(true)
    expect(canRetryBackupRequest({
      action: 'create', instanceStatus: 'stopped', hasActiveOperation: false,
    })).toBe(true)
    expect(canRetryBackupRequest({
      action: 'create', instanceStatus: 'backing_up', hasActiveOperation: true,
    })).toBe(false)
  })

  it('requires a ready version-matched backup before restore can be retried', () => {
    expect(canRetryBackupRequest({
      action: 'restore',
      instanceStatus: 'degraded',
      hasActiveOperation: false,
      backupStatus: 'ready',
      sameTemplateVersion: true,
    })).toBe(true)
    expect(canRetryBackupRequest({
      action: 'restore',
      instanceStatus: 'running',
      hasActiveOperation: false,
      backupStatus: 'restoring',
      sameTemplateVersion: true,
    })).toBe(false)
    expect(canRetryBackupRequest({
      action: 'restore',
      instanceStatus: 'running',
      hasActiveOperation: false,
      backupStatus: 'ready',
      sameTemplateVersion: false,
    })).toBe(false)
    expect(canRetryBackupRequest({
      action: 'restore',
      instanceStatus: 'restarting',
      hasActiveOperation: false,
      backupStatus: 'ready',
      sameTemplateVersion: true,
    })).toBe(false)
  })

  it('retries deletion only while the current backup is still deletable', () => {
    for (const backupStatus of ['ready', 'failed']) {
      expect(canRetryBackupRequest({
        action: 'delete',
        instanceStatus: 'running',
        hasActiveOperation: false,
        backupStatus,
      })).toBe(true)
    }
    expect(canRetryBackupRequest({
      action: 'delete',
      instanceStatus: 'running',
      hasActiveOperation: false,
      backupStatus: 'deleting',
    })).toBe(false)
  })

  it('never offers a write retry for permission and missing-resource failures', () => {
    for (const errorCode of ['forbidden', 'unauthorized', 'not_found']) {
      expect(canRetryBackupRequest({
        action: 'create',
        instanceStatus: 'running',
        hasActiveOperation: false,
        errorCode,
      })).toBe(false)
    }
  })

  it('selects recovery guidance from stable API error codes', () => {
    expect(backupRequestRecoveryKey('resource_conflict')).toBe('backupRequestRecoveryConflict')
    expect(backupRequestRecoveryKey('resource_unavailable')).toBe('backupRequestRecoveryUnavailable')
    expect(backupRequestRecoveryKey('forbidden')).toBe('backupRequestRecoveryForbidden')
    expect(backupRequestRecoveryKey('not_found')).toBe('backupRequestRecoveryNotFound')
    expect(backupRequestRecoveryKey('internal_error')).toBe('backupRequestRecoveryDefault')
  })
})
