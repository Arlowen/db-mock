import { describe, expect, it } from 'vitest'
import { hostTaskRecoveryPhase, isRecoveryTaskActive, isRecoveryTaskRetryable, taskHostRecoveryPath, taskRecoveryResourcePath } from './task-recovery'
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
  })

  it('derives only known resource destinations', () => {
    expect(taskRecoveryResourcePath(task)).toBe('/instances/instance-id')
    expect(taskRecoveryResourcePath({ ...task, resourceType: 'host', resourceId: 'host-id' })).toBe('/hosts?host=host-id')
    expect(taskRecoveryResourcePath({ ...task, resourceType: 'backup' })).toBeUndefined()
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
