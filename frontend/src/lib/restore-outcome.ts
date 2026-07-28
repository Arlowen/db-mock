import type { Instance, Task } from './types'

export type RestoreOutcomeState = 'pre_restore_recovered' | 'rollback_incomplete'

export interface RestoreOutcome {
  state: RestoreOutcomeState
  instanceStatus?: string
}

const failedTaskStatuses = new Set(['failed', 'canceled', 'interrupted'])
const recoveredStatusMessage = 'Restore failed; the pre-restore database state was recovered'
const rollbackIncompleteStatusMessage = 'Restore failed and automatic rollback did not complete'

function stringResult(task: Pick<Task, 'result'>, key: string) {
  const value = task.result?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function restoreOutcome(
  task?: Pick<Task, 'kind'> & Partial<Pick<Task, 'status' | 'result'>>,
  instance?: Pick<Instance, 'status' | 'statusMessage'>,
): RestoreOutcome | undefined {
  if (!task?.status || task.kind.replaceAll('.', '_') !== 'instance_restore' || !failedTaskStatuses.has(task.status)) return undefined

  const persisted = stringResult(task, 'restoreOutcome')
  if (persisted === 'pre_restore_recovered' || persisted === 'rollback_incomplete') {
    return { state: persisted, instanceStatus: instance?.status || stringResult(task, 'instanceStatus') }
  }
  if (instance?.statusMessage === recoveredStatusMessage) {
    return { state: 'pre_restore_recovered', instanceStatus: instance.status }
  }
  if (instance?.statusMessage === rollbackIncompleteStatusMessage) {
    return { state: 'rollback_incomplete', instanceStatus: instance.status }
  }
  if (task.status === 'canceled' && instance && ['running', 'stopped'].includes(instance.status) && !instance.statusMessage) {
    return { state: 'pre_restore_recovered', instanceStatus: instance.status }
  }
  return undefined
}
