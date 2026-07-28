import { taskFailureGuidance } from './task-failure'
import type { DashboardAttentionItem } from './types'

export interface DashboardAttentionGuidance {
  causeKey: string
  recoveryKey: string
  inspectHost: boolean
}

export function dashboardAttentionGuidance(item: DashboardAttentionItem): DashboardAttentionGuidance {
  if (item.taskId && item.taskKind) {
    const guidance = taskFailureGuidance({ kind: item.taskKind, errorCode: item.errorCode })
    return { causeKey: guidance.causeKey, recoveryKey: guidance.recoveryKey, inspectHost: guidance.inspectHost }
  }
  const status = item.resourceStatus === 'degraded' ? 'degraded' : 'failed'
  return {
    causeKey: `attentionInstanceCause_${status}`,
    recoveryKey: `attentionInstanceRecovery_${status}`,
    inspectHost: false,
  }
}

export function dashboardAttentionResourcePath(item: DashboardAttentionItem): string | undefined {
  if (item.resourceType === 'instance') return `/instances/${item.resourceId}`
  if (item.resourceType === 'host') return `/hosts?host=${item.resourceId}`
  return undefined
}

export function dashboardAttentionCanRetry(item: DashboardAttentionItem): boolean {
  return Boolean(item.taskId && ['failed', 'interrupted'].includes(item.taskStatus || ''))
}
