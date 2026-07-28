import type { Host, Task } from './types'

const activeTaskStatuses = new Set(['queued', 'running', 'retrying'])
const retryableTaskStatuses = new Set(['failed', 'canceled', 'interrupted'])

export type HostTaskRecoveryPhase = 'mismatch' | 'active' | 'succeeded' | 'ready' | 'needs_host' | 'unavailable'

export function taskHostRecoveryPath(hostID?: string, taskID?: string): string | undefined {
  if (!hostID?.trim() || !taskID?.trim()) return undefined
  const params = new URLSearchParams({ host: hostID, recoveryTask: taskID })
  return `/hosts?${params.toString()}`
}

export function taskRecoveryHostID(task?: Pick<Task, 'hostId' | 'resourceType' | 'resourceId'>): string | undefined {
  const hostID = task?.hostId || (task?.resourceType === 'host' ? task.resourceId : undefined)
  return hostID?.trim() || undefined
}

export function taskHostRecoveryPathForTask(task?: Pick<Task, 'id' | 'hostId' | 'resourceType' | 'resourceId'>): string | undefined {
  return taskHostRecoveryPath(taskRecoveryHostID(task), task?.id)
}

export function taskRecoveryResourcePath(task?: Task): string | undefined {
  if (!task?.resourceId) return undefined
  if (task.resourceType === 'instance') return `/instances/${encodeURIComponent(task.resourceId)}`
  if (task.resourceType === 'host') return `/hosts?host=${encodeURIComponent(task.resourceId)}`
  return undefined
}

export function isRecoveryTaskActive(task?: Task): boolean {
  return Boolean(task && activeTaskStatuses.has(task.status))
}

export function isRecoveryTaskRetryable(task?: Task): boolean {
  return Boolean(task && retryableTaskStatuses.has(task.status))
}

export function hostTaskRecoveryPhase(task: Task, host: Host, hostOperationActive: boolean): HostTaskRecoveryPhase {
  const taskHostID = task.hostId || (task.resourceType === 'host' ? task.resourceId : undefined)
  if (!taskHostID || taskHostID !== host.id) return 'mismatch'
  if (isRecoveryTaskActive(task)) return 'active'
  if (task.status === 'succeeded') return 'succeeded'
  if (!isRecoveryTaskRetryable(task)) return 'unavailable'
  return host.status === 'online' && !host.maintenance && !hostOperationActive ? 'ready' : 'needs_host'
}
