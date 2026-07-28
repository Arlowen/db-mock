import type { Task } from './types'
import { restoreOutcome } from './restore-outcome'

export interface TaskFailureGuidance {
  causeKey: string
  impactKey: string
  recoveryKey: string
  inspectHost: boolean
}

const knownFailureCodes = new Set([
  'ssh_unreachable',
  'ssh_credential_invalid',
  'ssh_host_key_changed',
  'operation_timeout',
  'image_pull_failed',
  'host_disk_full',
  'host_path_not_shared',
  'port_conflict',
  'health_check_failed',
])

const hostFailureCodes = new Set([
  'ssh_unreachable',
  'ssh_credential_invalid',
  'ssh_host_key_changed',
  'image_pull_failed',
  'host_disk_full',
  'host_path_not_shared',
  'port_conflict',
])

function normalizedKind(kind: string) {
  return kind.replaceAll('.', '_')
}

function impactKey(kind: string) {
  const normalized = normalizedKind(kind)
  if (normalized.startsWith('host_')) return 'taskFailureImpact_host'
  if ([
    'instance_create',
    'instance_start',
    'instance_stop',
    'instance_restart',
    'instance_delete',
    'instance_upgrade',
    'instance_reconfigure',
    'instance_backup',
    'instance_restore',
    'instance_backup_delete',
  ].includes(normalized)) return `taskFailureImpact_${normalized}`
  return 'taskFailureImpact_generic'
}

export function taskFailureGuidance(task: Pick<Task, 'kind' | 'errorCode'> & Partial<Pick<Task, 'status' | 'result'>>): TaskFailureGuidance {
  const code = task.errorCode && knownFailureCodes.has(task.errorCode) ? task.errorCode : 'task_failed'
  const restore = restoreOutcome(task)
  if (restore) {
    return {
      causeKey: `taskFailureCause_${code}`,
      impactKey: `taskFailureImpact_instance_restore_${restore.state}`,
      recoveryKey: `taskFailureRecovery_instance_restore_${restore.state}`,
      inspectHost: false,
    }
  }
  return {
    causeKey: `taskFailureCause_${code}`,
    impactKey: impactKey(task.kind),
    recoveryKey: `taskFailureRecovery_${code}`,
    inspectHost: hostFailureCodes.has(code),
  }
}
