import { taskRecoveryInstanceID, taskRecoveryResourcePath } from './task-recovery'
import type { Task } from './types'

export interface TaskResourceReference {
  lookupType?: 'host' | 'instance'
  lookupID?: string
  fallbackID?: string
  path?: string
}

export function taskResourceReference(task: Task): TaskResourceReference {
  const resourceID = task.resourceId?.trim() || undefined
  if (task.resourceType === 'host' && resourceID) {
    return { lookupType: 'host', lookupID: resourceID, fallbackID: resourceID, path: taskRecoveryResourcePath(task) }
  }
  if (task.resourceType === 'instance' && resourceID) {
    return { lookupType: 'instance', lookupID: resourceID, fallbackID: resourceID, path: taskRecoveryResourcePath(task) }
  }
  if (task.resourceType === 'backup') {
    const instanceID = taskRecoveryInstanceID(task)
    if (instanceID) {
      return { lookupType: 'instance', lookupID: instanceID, fallbackID: resourceID || instanceID, path: taskRecoveryResourcePath(task) }
    }
  }
  return { fallbackID: resourceID }
}
