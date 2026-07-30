import { describe, expect, it } from 'vitest'
import { instanceHandoffAvailability, instanceHandoffRestoreVerification } from './instance-handoff'
import type { InstanceBackup, Task } from './types'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'restore-1',
    kind: 'instance.restore',
    status: 'succeeded',
    resourceType: 'instance',
    resourceId: 'instance-1',
    progress: 100,
    stage: 'completed',
    message: 'task_completed',
    payload: { backupId: 'backup-1' },
    result: {
      backupId: 'backup-1',
      backupName: 'orders-release',
      backupCreatedAt: '2026-07-29T10:00:00Z',
      healthVerifiedAt: '2026-07-30T02:30:00Z',
      instanceStatus: 'running',
      restoreOutcome: 'target_backup_applied',
    },
    cancelable: false,
    cancelAsked: false,
    attempts: 1,
    createdAt: '2026-07-30T02:00:00Z',
    ...overrides,
  }
}

const backup = {
  id: 'backup-1',
  instanceId: 'instance-1',
  hostId: 'host-1',
  templateVersionId: 'version-1',
  templateVersion: '17',
  name: 'orders-release',
  creationType: 'manual',
  status: 'ready',
  sizeBytes: 1024,
  createdBy: 'user-1',
  createdByUsername: 'operator',
  createdAt: '2026-07-29T10:00:00Z',
  updatedAt: '2026-07-29T10:10:00Z',
} satisfies InstanceBackup

describe('instanceHandoffAvailability', () => {
  it('only enables direct handoff for credential readers while the database is running', () => {
    expect(instanceHandoffAvailability({ status: 'running' }, true)).toBe('ready')
    expect(instanceHandoffAvailability({ status: 'stopped' }, true)).toBe('unavailable')
    expect(instanceHandoffAvailability({ status: 'running' }, false)).toBe('restricted')
  })
})

describe('instanceHandoffRestoreVerification', () => {
  it('carries the latest verified restore into the list handoff', () => {
    const verification = instanceHandoffRestoreVerification(
      { id: 'instance-1', status: 'running' },
      [task(), task({ id: 'other-instance', resourceId: 'instance-2' })],
      [backup],
    )

    expect(verification).toMatchObject({
      backupId: 'backup-1',
      backupName: 'orders-release',
      backupCreatedAt: '2026-07-29T10:00:00Z',
      healthVerifiedAt: '2026-07-30T02:30:00Z',
      currentStatus: 'running',
    })
  })

  it('does not describe failed restores as the current data version', () => {
    expect(instanceHandoffRestoreVerification(
      { id: 'instance-1', status: 'running' },
      [task({ status: 'failed' })],
      [backup],
    )).toBeUndefined()
  })
})
