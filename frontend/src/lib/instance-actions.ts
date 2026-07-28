import type { Instance, Task } from './types'

export type InstanceQuickAction = 'start' | 'stop'
export type InstanceBatchAction = InstanceQuickAction | 'restart'

export function instanceQuickAction(status: string): InstanceQuickAction | null {
  if (status === 'running' || status === 'degraded') return 'stop'
  if (status === 'stopped') return 'start'
  return null
}

export interface InstanceBatchActionPlan {
  action: InstanceBatchAction
  eligible: Instance[]
  skipped: Instance[]
}

export interface InstanceBatchAccepted {
  instanceId: string
  instanceName: string
  task: Task
}

export interface InstanceBatchRejected {
  instanceId: string
  instanceName?: string
  code: string
  message: string
}

export interface InstanceBatchActionResponse {
  action: InstanceBatchAction
  accepted: InstanceBatchAccepted[]
  rejected: InstanceBatchRejected[]
}

export interface InstanceBatchActionResult extends InstanceBatchActionResponse {
  skipped: Instance[]
}

export interface InstanceBatchTaskGroups {
  active: InstanceBatchAccepted[]
  succeeded: InstanceBatchAccepted[]
  failed: InstanceBatchAccepted[]
}

const failedTaskStatuses = new Set(['failed', 'canceled', 'interrupted'])

export function canBatchInstanceAction(status: string, action: InstanceBatchAction): boolean {
  if (action === 'start') return status === 'stopped'
  return (action === 'stop' || action === 'restart') && (status === 'running' || status === 'degraded')
}

export function instanceBatchActionPlan(instances: Instance[], action: InstanceBatchAction): InstanceBatchActionPlan {
  const eligible: Instance[] = []
  const skipped: Instance[] = []
  for (const instance of instances) {
    if (canBatchInstanceAction(instance.status, action)) eligible.push(instance)
    else skipped.push(instance)
  }
  return { action, eligible, skipped }
}

export function instanceBatchTaskGroups(accepted: InstanceBatchAccepted[]): InstanceBatchTaskGroups {
  const groups: InstanceBatchTaskGroups = { active: [], succeeded: [], failed: [] }
  for (const item of accepted) {
    if (item.task.status === 'succeeded') groups.succeeded.push(item)
    else if (failedTaskStatuses.has(item.task.status)) groups.failed.push(item)
    else groups.active.push(item)
  }
  return groups
}
