import { describe, expect, it } from 'vitest'
import { latestRestoreTask, restoreVerification } from './restore-verification'
import type { InstanceBackup, Task } from './types'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'instance.restore',
    status: 'succeeded',
    resourceType: 'instance',
    progress: 100,
    stage: 'compose',
    message: 'task_completed',
    payload: { backupId: 'backup-1' },
    result: { backupId: 'backup-1', status: 'running' },
    cancelable: false,
    cancelAsked: false,
    attempts: 1,
    createdAt: '2026-07-28T08:00:00Z',
    finishedAt: '2026-07-28T08:01:00Z',
    ...overrides,
  }
}

const backup = {
  id: 'backup-1',
  name: 'Orders release baseline',
  createdAt: '2026-07-27T08:00:00Z',
  sha256: 'a'.repeat(64),
} as InstanceBackup

describe('restore verification', () => {
  it('uses the durable success result even after the backup record is deleted', () => {
    expect(restoreVerification(task({
      result: {
        backupId: 'backup-1',
        restoreOutcome: 'target_backup_applied',
        backupName: 'Orders release baseline',
        backupCreatedAt: '2026-07-27T08:00:00Z',
        backupSha256: 'a'.repeat(64),
        healthVerifiedAt: '2026-07-28T08:00:30Z',
        instanceStatus: 'running',
      },
    }))).toMatchObject({
      backupId: 'backup-1',
      backupName: 'Orders release baseline',
      backupCreatedAt: '2026-07-27T08:00:00Z',
      healthVerifiedAt: '2026-07-28T08:00:30Z',
      restoredStatus: 'running',
    })
  })

  it('supports successful historical tasks by joining the backup inventory', () => {
    expect(restoreVerification(task(), [backup], { status: 'running' })).toMatchObject({
      backupName: 'Orders release baseline',
      backupCreatedAt: '2026-07-27T08:00:00Z',
      backupSha256: 'a'.repeat(64),
      healthVerifiedAt: '2026-07-28T08:01:00Z',
      restoredStatus: 'running',
      currentStatus: 'running',
    })
  })

  it('rejects failed, unrelated, and contradictory task outcomes', () => {
    expect(restoreVerification(task({ status: 'failed' }))).toBeUndefined()
    expect(restoreVerification(task({ kind: 'instance.backup' }))).toBeUndefined()
    expect(restoreVerification(task({ result: { backupId: 'backup-1', status: 'running', restoreOutcome: 'rollback_incomplete' } }))).toBeUndefined()
  })

  it('selects the newest restore independently of later non-restore operations', () => {
    const tasks = [
      task({ id: 'restart', kind: 'instance.restart', createdAt: '2026-07-28T09:00:00Z' }),
      task({ id: 'restore', createdAt: '2026-07-28T08:00:00Z' }),
    ]
    expect(latestRestoreTask(tasks)?.id).toBe('restore')
  })
})
