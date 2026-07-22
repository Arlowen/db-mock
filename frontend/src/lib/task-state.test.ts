import { describe, expect, it } from 'vitest'
import { isRecoverableInstanceStatus, isTaskCancellationPending, selectRecoveryTasks } from './task-state'
import type { Task } from './types'

function task(id: string, status: string, createdAt: string): Task {
  return { id, kind: 'host.probe', status, resourceType: 'host', resourceId: 'host-1', progress: 0, stage: status, message: '', cancelable: false, cancelAsked: false, attempts: 1, createdAt }
}

describe('selectRecoveryTasks', () => {
  it('does not surface an older failure after the latest task succeeds', () => {
    const result = selectRecoveryTasks([
      task('latest', 'succeeded', '2026-07-19T00:02:00Z'),
      task('older', 'failed', '2026-07-19T00:01:00Z'),
    ], true)

    expect(result.operationTask).toBeUndefined()
    expect(result.failedTask).toBeUndefined()
  })

  it('shows the active retry instead of the failed task it replaces', () => {
    const result = selectRecoveryTasks([
      task('retry', 'queued', '2026-07-19T00:02:00Z'),
      task('failed', 'failed', '2026-07-19T00:01:00Z'),
    ], true)

    expect(result.activeTask?.id).toBe('retry')
    expect(result.failedTask).toBeUndefined()
    expect(result.operationTask?.id).toBe('retry')
  })

  it('keeps a task active while it waits for its retry window', () => {
    expect(selectRecoveryTasks([task('retrying', 'retrying', '2026-07-19T00:02:00Z')], true).activeTask?.id).toBe('retrying')
  })

  it('offers recovery only for the latest failed task and a recoverable resource', () => {
    const tasks = [task('latest', 'failed', '2026-07-19T00:02:00Z')]

    expect(selectRecoveryTasks(tasks, true).failedTask?.id).toBe('latest')
    expect(selectRecoveryTasks(tasks, false).failedTask).toBeUndefined()
  })
})

describe('instance task recovery', () => {
  it('keeps interrupted operation states recoverable after a control-service restart', () => {
    for (const status of ['provisioning', 'starting', 'stopping', 'restarting', 'upgrading', 'reconfiguring', 'backing_up', 'restoring', 'deleting', 'failed', 'degraded']) {
      expect(isRecoverableInstanceStatus(status)).toBe(true)
    }
  })

  it('does not offer recovery for stable instance states', () => {
    for (const status of ['running', 'stopped', 'deleted']) {
      expect(isRecoverableInstanceStatus(status)).toBe(false)
    }
  })
})

describe('task cancellation state', () => {
  it('shows a pending request only while the task is active', () => {
    const running = task('running', 'running', '2026-07-19T00:02:00Z')
    running.cancelAsked = true
    expect(isTaskCancellationPending(running)).toBe(true)

    for (const status of ['canceled', 'failed', 'succeeded', 'interrupted']) {
      const finished = task(status, status, '2026-07-19T00:02:00Z')
      finished.cancelAsked = true
      expect(isTaskCancellationPending(finished)).toBe(false)
    }
  })
})
