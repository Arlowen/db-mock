import type { Instance, InstanceBackup, Task } from './types'
import { latestRestoreTask, restoreVerification, type RestoreVerification } from './restore-verification'

export type InstanceHandoffAvailability = 'ready' | 'restricted' | 'unavailable'

export function instanceHandoffAvailability(
  instance: Pick<Instance, 'status'>,
  canReadCredentials: boolean,
): InstanceHandoffAvailability {
  if (!canReadCredentials) return 'restricted'
  return instance.status === 'running' ? 'ready' : 'unavailable'
}

export function instanceHandoffRestoreVerification(
  instance: Pick<Instance, 'id' | 'status'>,
  tasks: Task[],
  backups: InstanceBackup[],
): RestoreVerification | undefined {
  const instanceTasks = tasks.filter((task) => task.resourceType === 'instance' && task.resourceId === instance.id)
  return restoreVerification(latestRestoreTask(instanceTasks), backups, instance)
}
