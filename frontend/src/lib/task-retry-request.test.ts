import { describe, expect, it } from 'vitest'
import { taskRetryRequestEvidence, type TaskRetryRequestFailure } from './task-retry-request'
import type { Task } from './types'

const attemptedAt = '2026-07-31T10:00:00.000Z'
const original = {
  id: 'original-task',
  kind: 'instance.restart',
  status: 'failed',
  resourceType: 'instance',
  resourceId: 'instance-id',
  progress: 58,
  stage: 'compose',
  message: 'task_failed',
  payload: { operationId: 'operation-id' },
  cancelable: false,
  cancelAsked: false,
  attempts: 1,
  createdAt: '2026-07-31T09:50:00.000Z',
} satisfies Task
const rejectedFailure: TaskRetryRequestFailure = {
  taskId: original.id,
  code: 'resource_conflict',
  message: 'another operation is active',
  serverRejected: true,
  attemptedAt,
  evidenceChecks: 1,
}

describe('task retry request evidence', () => {
  it('follows a newly queued retry with the same operation lineage', () => {
    const successor = {
      ...original,
      id: 'retry-task',
      status: 'queued',
      createdAt: attemptedAt,
    }
    expect(taskRetryRequestEvidence(rejectedFailure, [original, successor])).toMatchObject({
      phase: 'accepted',
      successor,
      canRetry: false,
    })
  })

  it('identifies the active operation that blocks another retry', () => {
    const blocker = {
      ...original,
      id: 'backup-task',
      kind: 'instance.backup',
      status: 'running',
      payload: { operationId: 'backup-operation' },
      createdAt: '2026-07-31T09:59:00.000Z',
    }
    expect(taskRetryRequestEvidence(rejectedFailure, [original, blocker])).toMatchObject({
      phase: 'blocked',
      blocker,
      canRetry: false,
    })
  })

  it('allows a stable rejected request to be retried after blockers clear', () => {
    expect(taskRetryRequestEvidence(rejectedFailure, [original])).toEqual({
      phase: 'ready',
      original,
      canRetry: true,
    })
  })

  it('requires two successful evidence checks after an ambiguous network result', () => {
    const ambiguous = { ...rejectedFailure, code: 'network_error', serverRejected: false }
    expect(taskRetryRequestEvidence(ambiguous, [original])).toMatchObject({ phase: 'stale', canRetry: false })
    expect(taskRetryRequestEvidence({ ...ambiguous, evidenceChecks: 2 }, [original])).toMatchObject({ phase: 'ready', canRetry: true })
  })

  it('does not offer another retry when permission, identity, or task state is invalid', () => {
    for (const code of ['forbidden', 'unauthorized', 'not_found', 'invalid_input']) {
      expect(taskRetryRequestEvidence({ ...rejectedFailure, code }, [original])).toMatchObject({ phase: 'unavailable', canRetry: false })
    }
    expect(taskRetryRequestEvidence(rejectedFailure, [{ ...original, status: 'succeeded' }])).toMatchObject({ phase: 'unavailable', canRetry: false })
    expect(taskRetryRequestEvidence(rejectedFailure, [])).toMatchObject({ phase: 'stale', canRetry: false })
  })
})
