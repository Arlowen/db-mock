import type { Task } from './types'

const activeStatuses = new Set(['queued', 'running', 'retrying'])
const retryableStatuses = new Set(['failed', 'canceled', 'interrupted'])
const unavailableCodes = new Set(['forbidden', 'unauthorized', 'not_found', 'invalid_input'])

export interface TaskRetryRequestFailure {
  taskId: string
  code: string
  message: string
  serverRejected: boolean
  attemptedAt: string
  evidenceChecks: number
}

export type TaskRetryRequestPhase = 'accepted' | 'blocked' | 'ready' | 'stale' | 'unavailable'

export interface TaskRetryRequestEvidence {
  phase: TaskRetryRequestPhase
  original?: Task
  successor?: Task
  blocker?: Task
  canRetry: boolean
}

function operationID(task: Task): string {
  const value = task.payload?.operationId
  return typeof value === 'string' && value.trim() ? value.trim() : task.id
}

function sameResource(left: Task, right: Task): boolean {
  return left.resourceType === right.resourceType
    && Boolean(left.resourceId)
    && left.resourceId === right.resourceId
}

function createdAfterAttempt(task: Task, attemptedAt: string): boolean {
  const taskTime = Date.parse(task.createdAt)
  const attemptTime = Date.parse(attemptedAt)
  return Number.isFinite(taskTime) && Number.isFinite(attemptTime) && taskTime >= attemptTime - 1000
}

export function taskRetryRequestEvidence(
  failure: TaskRetryRequestFailure,
  tasks: Task[],
): TaskRetryRequestEvidence {
  const original = tasks.find((task) => task.id === failure.taskId)
  if (unavailableCodes.has(failure.code)) return { phase: 'unavailable', original, canRetry: false }
  if (!original) return { phase: 'stale', canRetry: false }

  const originalOperationID = operationID(original)
  const successor = tasks.find((task) =>
    task.id !== original.id
    && task.kind === original.kind
    && sameResource(task, original)
    && operationID(task) === originalOperationID
    && createdAfterAttempt(task, failure.attemptedAt),
  )
  if (successor) return { phase: 'accepted', original, successor, canRetry: false }

  const blocker = tasks.find((task) =>
    task.id !== original.id
    && sameResource(task, original)
    && activeStatuses.has(task.status),
  )
  if (blocker) return { phase: 'blocked', original, blocker, canRetry: false }

  if (!retryableStatuses.has(original.status)) {
    return { phase: 'unavailable', original, canRetry: false }
  }

  const evidenceConfirmed = failure.serverRejected || failure.evidenceChecks >= 2
  return {
    phase: evidenceConfirmed ? 'ready' : 'stale',
    original,
    canRetry: evidenceConfirmed,
  }
}
