import type { InstanceBackup, Task } from './types'

const backupDeleteKinds = new Set(['instance.backup.delete', 'instance_backup_delete'])
const failedTaskStatuses = new Set(['failed', 'canceled', 'interrupted'])

export interface BackupDeleteRecovery {
  backup: InstanceBackup
  task: Task
}

function isBackupDeleteTask(task: Task, backupID: string) {
  return backupDeleteKinds.has(task.kind) && task.resourceType === 'backup' && task.resourceId === backupID
}

export function latestBackupDeleteTask(tasks: Task[], backupID: string): Task | undefined {
  return tasks
    .filter((task) => isBackupDeleteTask(task, backupID))
    .reduce<Task | undefined>((latest, task) => {
      if (!latest) return task
      return new Date(task.createdAt).getTime() > new Date(latest.createdAt).getTime() ? task : latest
    }, undefined)
}

export function failedBackupDeleteRecoveries(backups: InstanceBackup[], tasks: Task[]): BackupDeleteRecovery[] {
  return backups.flatMap((backup) => {
    const task = latestBackupDeleteTask(tasks, backup.id)
    return task && failedTaskStatuses.has(task.status) ? [{ backup, task }] : []
  })
}
