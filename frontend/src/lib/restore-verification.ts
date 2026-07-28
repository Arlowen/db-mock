import type { Instance, InstanceBackup, Task } from './types'

export interface RestoreVerification {
  task: Task
  backupId: string
  backupName?: string
  backupCreatedAt?: string
  backupSha256?: string
  healthVerifiedAt?: string
  restoredStatus?: string
  currentStatus?: string
}

function resultString(task: Pick<Task, 'result'>, key: string) {
  const value = task.result?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function taskString(task: Pick<Task, 'payload' | 'result'>, key: string) {
  return resultString(task, key) || (typeof task.payload?.[key] === 'string' && String(task.payload[key]).trim()
    ? String(task.payload[key]).trim()
    : undefined)
}

export function isRestoreTask(task?: Pick<Task, 'kind'>) {
  return task?.kind.replaceAll('.', '_') === 'instance_restore'
}

export function latestRestoreTask(tasks: Task[]) {
  return tasks.find(isRestoreTask)
}

export function restoreVerification(
  task?: Task,
  backups: InstanceBackup[] = [],
  instance?: Pick<Instance, 'status'>,
): RestoreVerification | undefined {
  if (!task || !isRestoreTask(task) || task.status !== 'succeeded') return undefined

  const backupId = taskString(task, 'backupId')
  const restoredStatus = resultString(task, 'instanceStatus') || resultString(task, 'status')
  const outcome = resultString(task, 'restoreOutcome')
  if (!backupId || (outcome && outcome !== 'target_backup_applied') || !restoredStatus) return undefined

  const backup = backups.find((candidate) => candidate.id === backupId)
  return {
    task,
    backupId,
    backupName: resultString(task, 'backupName') || backup?.name,
    backupCreatedAt: resultString(task, 'backupCreatedAt') || backup?.createdAt,
    backupSha256: resultString(task, 'backupSha256') || backup?.sha256,
    healthVerifiedAt: resultString(task, 'healthVerifiedAt') || task.finishedAt,
    restoredStatus,
    currentStatus: instance?.status,
  }
}
