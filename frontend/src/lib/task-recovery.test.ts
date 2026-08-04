import { describe, expect, it } from 'vitest'
import { hostTaskRecoveryPhase, isRecoveryTaskActive, isRecoveryTaskRetryable, recoveryConfirmationPhase, selectRecoveryConfirmationTask, taskHostRecoveryPath, taskHostRecoveryPathForTask, taskRecoveryConfirmationPath, taskRecoveryHostID, taskRecoveryInstanceID, taskRecoveryResourcePath } from './task-recovery'
import type { Host, Task } from './types'

const host = { id: 'host-id', status: 'online', maintenance: false } as Host
const task = {
  id: 'task-id',
  kind: 'instance.create',
  status: 'failed',
  resourceType: 'instance',
  resourceId: 'instance-id',
  hostId: 'host-id',
} as Task

describe('task recovery helpers', () => {
  it('builds a host path that preserves the failed task context', () => {
    expect(taskHostRecoveryPath('host id', 'task/id')).toBe('/hosts?host=host+id&recoveryTask=task%2Fid')
    expect(taskHostRecoveryPath('', 'task-id')).toBeUndefined()
    expect(taskHostRecoveryPathForTask(task)).toBe('/hosts?host=host-id&recoveryTask=task-id')
  })

  it('derives the recovery host from either the task host or a host resource', () => {
    expect(taskRecoveryHostID(task)).toBe('host-id')
    expect(taskRecoveryHostID({ ...task, hostId: undefined, resourceType: 'host', resourceId: 'host-resource-id' })).toBe('host-resource-id')
    expect(taskHostRecoveryPathForTask({ ...task, hostId: undefined, resourceType: 'instance' })).toBeUndefined()
  })

  it('derives only known resource destinations', () => {
    expect(taskRecoveryResourcePath(task)).toBe('/instances/instance-id')
    expect(taskRecoveryResourcePath({ ...task, resourceType: 'host', resourceId: 'host-id' })).toBe('/hosts?host=host-id')
    const backupTask = { ...task, resourceType: 'backup', resourceId: 'backup-id', payload: { instanceId: 'instance id' } }
    expect(taskRecoveryInstanceID(backupTask)).toBe('instance id')
    expect(taskRecoveryResourcePath(backupTask)).toBe('/instances/instance%20id')
    expect(taskRecoveryResourcePath({ ...backupTask, payload: {} })).toBeUndefined()
  })

  it('builds and validates an instance-scoped recovery confirmation', () => {
    const succeeded = { ...task, id: 'retry task', status: 'succeeded' }

    expect(taskRecoveryConfirmationPath(succeeded)).toBe('/instances/instance-id?recoveryTask=retry+task')
    expect(taskRecoveryConfirmationPath({ ...succeeded, resourceType: 'backup' })).toBeUndefined()
    expect(selectRecoveryConfirmationTask([succeeded], 'instance-id', 'retry task')).toEqual(succeeded)
    expect(selectRecoveryConfirmationTask([{ ...succeeded, status: 'failed' }], 'instance-id', 'retry task')).toBeUndefined()
    expect(selectRecoveryConfirmationTask([succeeded], 'another-instance', 'retry task')).toBeUndefined()
    expect(selectRecoveryConfirmationTask([succeeded], 'instance-id', 'missing')).toBeUndefined()
  })

  it('distinguishes expected health convergence from a recovery that still needs investigation', () => {
    expect(recoveryConfirmationPhase({ status: 'running', desiredState: 'running' })).toBe('ready')
    expect(recoveryConfirmationPhase({ status: 'stopped', desiredState: 'stopped' })).toBe('stopped')
    expect(recoveryConfirmationPhase({
      status: 'degraded',
      desiredState: 'running',
      statusMessage: 'Container health check is starting',
    })).toBe('converging')
    expect(recoveryConfirmationPhase({
      status: 'degraded',
      desiredState: 'running',
      statusMessage: 'Container health check is failing',
    })).toBe('review')
    expect(recoveryConfirmationPhase({
      status: 'degraded',
      desiredState: 'stopped',
      statusMessage: 'Container health check is starting',
    })).toBe('review')
  })

  it('requires a ready host before retry and follows the retried task state', () => {
    expect(hostTaskRecoveryPhase(task, host, false)).toBe('ready')
    expect(hostTaskRecoveryPhase(task, { ...host, status: 'offline' }, false)).toBe('needs_host')
    expect(hostTaskRecoveryPhase(task, host, true)).toBe('needs_host')
    expect(hostTaskRecoveryPhase({ ...task, status: 'queued' }, host, false)).toBe('active')
    expect(hostTaskRecoveryPhase({ ...task, status: 'succeeded' }, host, false)).toBe('succeeded')
  })

  it('rejects mismatched and non-retryable task contexts', () => {
    expect(hostTaskRecoveryPhase({ ...task, hostId: 'other-host' }, host, false)).toBe('mismatch')
    expect(hostTaskRecoveryPhase({ ...task, status: 'pending' }, host, false)).toBe('unavailable')
    expect(isRecoveryTaskActive({ ...task, status: 'running' })).toBe(true)
    expect(isRecoveryTaskRetryable({ ...task, status: 'canceled' })).toBe(true)
  })
})
