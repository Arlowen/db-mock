export type CleanupEvidenceState = 'loading' | 'ready' | 'error'

export type CleanupContinuationPhase =
  | 'loading'
  | 'unavailable'
  | 'processing'
  | 'failed'
  | 'blocked'
  | 'ready'

const activeBackupStatuses = new Set(['creating', 'restoring', 'deleting'])

export function cleanupEvidenceState(...states: CleanupEvidenceState[]): CleanupEvidenceState {
  if (states.includes('error')) return 'error'
  if (states.includes('loading')) return 'loading'
  return 'ready'
}

interface CleanupContinuationInput {
  evidenceState: CleanupEvidenceState
  backupStatuses: string[]
  hasActiveTask: boolean
  failedBackupDeleteCount?: number
}

export function cleanupContinuationPhase({
  evidenceState,
  backupStatuses,
  hasActiveTask,
  failedBackupDeleteCount = 0,
}: CleanupContinuationInput): CleanupContinuationPhase {
  if (evidenceState === 'loading') return 'loading'
  if (evidenceState === 'error') return 'unavailable'
  if (hasActiveTask || backupStatuses.some((status) => activeBackupStatuses.has(status))) return 'processing'
  if (failedBackupDeleteCount > 0) return 'failed'
  return backupStatuses.length > 0 ? 'blocked' : 'ready'
}

export function hasActiveBackupOperation(statuses: string[]): boolean {
  return statuses.some((status) => activeBackupStatuses.has(status))
}
