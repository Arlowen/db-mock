export type BackupRequestAction = 'create' | 'restore' | 'delete'

export type BackupRequestRetryState = {
  action: BackupRequestAction
  instanceStatus: string
  hasActiveOperation: boolean
  backupStatus?: string
  sameTemplateVersion?: boolean
  errorCode?: string
}

const retryBlockedCodes = new Set(['forbidden', 'unauthorized', 'not_found'])
const restorableInstanceStatuses = new Set(['running', 'stopped', 'degraded', 'failed'])

export function canRetryBackupRequest({
  action,
  instanceStatus,
  hasActiveOperation,
  backupStatus,
  sameTemplateVersion = false,
  errorCode = '',
}: BackupRequestRetryState) {
  if (retryBlockedCodes.has(errorCode)) return false
  if (action === 'create') {
    return !hasActiveOperation && (instanceStatus === 'running' || instanceStatus === 'stopped')
  }
  if (action === 'restore') {
    return !hasActiveOperation && restorableInstanceStatuses.has(instanceStatus) &&
      backupStatus === 'ready' && sameTemplateVersion
  }
  return backupStatus === 'ready' || backupStatus === 'failed'
}

export function backupRequestRecoveryKey(errorCode: string) {
  if (errorCode === 'resource_conflict') return 'backupRequestRecoveryConflict'
  if (errorCode === 'resource_unavailable') return 'backupRequestRecoveryUnavailable'
  if (errorCode === 'forbidden' || errorCode === 'unauthorized') return 'backupRequestRecoveryForbidden'
  if (errorCode === 'not_found') return 'backupRequestRecoveryNotFound'
  return 'backupRequestRecoveryDefault'
}
