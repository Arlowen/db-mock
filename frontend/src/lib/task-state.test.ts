import { describe, expect, it } from 'vitest'
import { canCancelTask, canReviewIncompleteDeploymentCleanup, deploymentTaskJourney, deploymentTaskNextStep, isRecoverableInstanceStatus, isTaskCancellationPending, selectDeploymentHandoff, selectRecoveryTasks } from './task-state'
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

describe('deployment handoff state', () => {
  it('keeps the create task visible while deployment is active', () => {
    const result = selectDeploymentHandoff([
      { ...task('create', 'running', '2026-07-19T00:02:00Z'), kind: 'instance.create', progress: 68 },
    ], 'provisioning')

    expect(result).toMatchObject({ state: 'active', task: { id: 'create', progress: 68 } })
  })

  it('offers connection handoff only after both the task and instance are ready', () => {
    const succeeded = { ...task('create', 'succeeded', '2026-07-19T00:02:00Z'), kind: 'instance.create', progress: 100 }

    expect(selectDeploymentHandoff([succeeded], 'running')).toMatchObject({ state: 'ready', task: { id: 'create' } })
    expect(selectDeploymentHandoff([succeeded], 'stopped')).toBeUndefined()
  })

  it('does not let an older success hide the latest failed deployment attempt', () => {
    const result = selectDeploymentHandoff([
      { ...task('latest', 'failed', '2026-07-19T00:03:00Z'), kind: 'instance.create' },
      { ...task('older', 'succeeded', '2026-07-19T00:02:00Z'), kind: 'instance.create' },
    ], 'failed')

    expect(result).toMatchObject({ state: 'failed', task: { id: 'latest' } })
  })
})

describe('deployment task journey', () => {
  it('keeps the next destination stable while a create task changes state', () => {
    const create = {
      ...task('create', 'running', '2026-07-19T00:02:00Z'),
      kind: 'instance.create',
      resourceType: 'instance',
      resourceId: 'instance/id',
    }

    expect(deploymentTaskJourney(create)).toEqual({
      state: 'active',
      instancePath: '/instances/instance%2Fid',
      connectionPath: '/instances/instance%2Fid?tab=connection',
    })
    expect(deploymentTaskJourney({ ...create, status: 'succeeded' })).toMatchObject({ state: 'ready' })
    for (const status of ['failed', 'canceled', 'interrupted']) {
      expect(deploymentTaskJourney({ ...create, status })).toMatchObject({ state: 'incomplete' })
    }
  })

  it('does not invent a deployment destination for unrelated or unscoped tasks', () => {
    expect(deploymentTaskJourney({ ...task('host', 'running', '2026-07-19T00:02:00Z'), kind: 'host.probe' })).toBeUndefined()
    expect(deploymentTaskJourney({ ...task('legacy', 'failed', '2026-07-19T00:02:00Z'), kind: 'instance_create', resourceType: 'instance', resourceId: undefined })).toBeUndefined()
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

  it('allows one safe cancellation request while a task is cancelable and active', () => {
    const running = task('running', 'running', '2026-07-19T00:02:00Z')
    running.cancelable = true
    expect(canCancelTask(running)).toBe(true)

    running.cancelAsked = true
    expect(canCancelTask(running)).toBe(false)
    running.cancelAsked = false
    running.status = 'succeeded'
    expect(canCancelTask(running)).toBe(false)
  })
})

describe('deployment next step', () => {
  it('explains the next automatic stage throughout instance creation', () => {
    const create = {
      ...task('create', 'running', '2026-07-19T00:02:00Z'),
      kind: 'instance.create',
    }

    expect(deploymentTaskNextStep({ ...create, stage: 'preflight' })).toBe('tuning')
    expect(deploymentTaskNextStep({ ...create, stage: 'image' })).toBe('render')
    expect(deploymentTaskNextStep({ ...create, stage: 'compose' })).toBe('health')
    expect(deploymentTaskNextStep({ ...create, stage: 'health' })).toBe('handoff')
  })

  it('does not promise a next stage after cancellation is requested or the task ends', () => {
    const create = {
      ...task('create', 'running', '2026-07-19T00:02:00Z'),
      kind: 'instance.create',
      stage: 'image',
    }

    expect(deploymentTaskNextStep({ ...create, cancelAsked: true })).toBeUndefined()
    expect(deploymentTaskNextStep({ ...create, status: 'failed' })).toBeUndefined()
    expect(deploymentTaskNextStep({ ...create, kind: 'instance.restart' })).toBeUndefined()
  })
})

describe('incomplete deployment cleanup', () => {
  it('offers cleanup review for every terminal incomplete create task', () => {
    const create = {
      ...task('create', 'failed', '2026-07-19T00:02:00Z'),
      kind: 'instance.create',
      resourceType: 'instance',
      resourceId: 'instance-1',
    }

    for (const status of ['failed', 'canceled', 'interrupted']) {
      expect(canReviewIncompleteDeploymentCleanup({ ...create, status })).toBe(true)
    }
  })

  it('does not treat active, successful, or unrelated tasks as failed deployments', () => {
    const create = {
      ...task('create', 'running', '2026-07-19T00:02:00Z'),
      kind: 'instance.create',
      resourceType: 'instance',
      resourceId: 'instance-1',
    }

    for (const status of ['queued', 'running', 'retrying', 'succeeded']) {
      expect(canReviewIncompleteDeploymentCleanup({ ...create, status })).toBe(false)
    }
    expect(canReviewIncompleteDeploymentCleanup({ ...create, kind: 'instance.restart', status: 'failed' })).toBe(false)
  })
})
