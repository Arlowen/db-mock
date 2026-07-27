import type { Instance } from './types'

export type InstanceQuickAction = 'start' | 'stop'

export function instanceQuickAction(status: string): InstanceQuickAction | null {
  if (status === 'running' || status === 'degraded') return 'stop'
  if (status === 'stopped') return 'start'
  return null
}

export interface InstanceBatchActionPlan {
  action: InstanceQuickAction
  eligible: Instance[]
  skipped: Instance[]
}

export function canBatchInstanceAction(status: string, action: InstanceQuickAction): boolean {
  if (action === 'start') return status === 'stopped'
  return status === 'running' || status === 'degraded'
}

export function instanceBatchActionPlan(instances: Instance[], action: InstanceQuickAction): InstanceBatchActionPlan {
  const eligible: Instance[] = []
  const skipped: Instance[] = []
  for (const instance of instances) {
    if (canBatchInstanceAction(instance.status, action)) eligible.push(instance)
    else skipped.push(instance)
  }
  return { action, eligible, skipped }
}
