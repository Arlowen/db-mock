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

export function taskRecoveryInstanceID(task?: Pick<Task, 'resourceType' | 'resourceId' | 'payload'>): string | undefined {
  if (task?.resourceType === 'instance') return task.resourceId?.trim() || undefined
  const instanceID = task?.payload?.instanceId
  return typeof instanceID === 'string' && instanceID.trim() ? instanceID.trim() : undefined
}

export function taskRecoveryResourcePath(task?: Task): string | undefined {
  if (!task) return undefined
  const instanceID = taskRecoveryInstanceID(task)
  if (task.resourceType === 'instance' && instanceID) return `/instances/${encodeURIComponent(instanceID)}`
  if (task.resourceType === 'backup' && instanceID) return `/instances/${encodeURIComponent(instanceID)}?tab=backups&cleanup=review`
  if (task.resourceType === 'host' && task.resourceId) return `/hosts?host=${encodeURIComponent(task.resourceId)}`
  return undefined
}

export function taskRecoveryConfirmationPath(task?: Task): string | undefined {
  const instanceID = taskRecoveryInstanceID(task)
  if (!task?.id?.trim() || task.resourceType !== 'instance' || !instanceID) return undefined
  const params = new URLSearchParams({ recoveryTask: task.id })
  return `/instances/${encodeURIComponent(instanceID)}?${params.toString()}`
}

export function selectRecoveryConfirmationTask(tasks: Task[], instanceID: string, requestedTaskID?: string): Task | undefined {
  const taskID = requestedTaskID?.trim()
  if (!taskID) return undefined
  return tasks.find((task) => task.id === taskID && task.status === 'succeeded' && task.resourceType === 'instance' && taskRecoveryInstanceID(task) === instanceID)
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
