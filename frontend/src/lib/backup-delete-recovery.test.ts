import { describe, expect, it } from 'vitest'
import { failedBackupDeleteRecoveries, latestBackupDeleteTask } from './backup-delete-recovery'
import type { InstanceBackup, Task } from './types'

const backup = { id: 'backup-1', name: 'Release snapshot' } as InstanceBackup
const failed = {
  id: 'task-failed',
  kind: 'instance.backup.delete',
  resourceType: 'backup',
  resourceId: backup.id,
  status: 'failed',
  createdAt: '2026-07-28T00:01:00Z',
} as Task

describe('backup delete recovery', () => {
  it('finds the latest delete task for the current backup', () => {
    const older = { ...failed, id: 'task-older', createdAt: '2026-07-28T00:00:00Z' }
    const unrelated = { ...failed, id: 'task-unrelated', resourceId: 'backup-2' }
    expect(latestBackupDeleteTask([older, unrelated, failed], backup.id)?.id).toBe(failed.id)
  })

  it('shows a failed, canceled, or interrupted latest attempt as recoverable', () => {
    expect(failedBackupDeleteRecoveries([backup], [failed])).toEqual([{ backup, task: failed }])
    expect(failedBackupDeleteRecoveries([backup], [{ ...failed, status: 'interrupted' }])).toHaveLength(1)
  })

  it('suppresses an old failure after a newer retry is queued', () => {
    const retry = {
      ...failed,
      id: 'task-retry',
      status: 'queued',
      createdAt: '2026-07-28T00:02:00Z',
    }
    expect(failedBackupDeleteRecoveries([backup], [failed, retry])).toEqual([])
  })
})
