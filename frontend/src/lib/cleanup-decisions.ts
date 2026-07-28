import { ApiError, errorMessage } from './api'
import type { DashboardInstance, Instance } from './types'

export type CleanupDecision = 'extend' | 'retain'

export interface BatchCleanupDecisionUpdated {
  instanceId: string
  instanceName: string
  instance: Instance
}

export interface BatchCleanupDecisionRejected {
  instanceId: string
  instanceName?: string
  code: string
  message: string
}

export interface BatchCleanupDecisionResponse {
  decision: CleanupDecision
  days: number
  updated: BatchCleanupDecisionUpdated[]
  rejected: BatchCleanupDecisionRejected[]
}

export interface CleanupDecisionPreview {
  instance: DashboardInstance
  nextExpiresAt?: string
}

export function cleanupDecisionPreview(
  instance: DashboardInstance,
  decision: CleanupDecision,
  days: number,
  now: Date = new Date(),
): CleanupDecisionPreview {
  if (decision === 'retain') return { instance }
  const current = new Date(instance.expiresAt)
  const base = Number.isNaN(current.getTime()) || current <= now ? new Date(now) : current
  base.setUTCDate(base.getUTCDate() + days)
  return { instance, nextExpiresAt: base.toISOString() }
}

export function cleanupDecisionRejectedMessage(item: BatchCleanupDecisionRejected): string {
  const status = item.code === 'not_found' ? 404
    : item.code === 'resource_conflict' ? 409
      : item.code === 'forbidden' ? 403
        : item.code === 'unauthorized' ? 401
          : item.code === 'resource_unavailable' ? 503
            : item.code === 'invalid_input' ? 400
              : 500
  return errorMessage(new ApiError(status, item.code, item.message))
}
