export type InstanceLifecycleAction = 'start' | 'stop' | 'restart'

const lifecycleActions = new Set<InstanceLifecycleAction>(['start', 'stop', 'restart'])
const retryBlockedCodes = new Set(['forbidden', 'unauthorized', 'not_found'])

export function isInstanceLifecycleAction(action: string): action is InstanceLifecycleAction {
  return lifecycleActions.has(action as InstanceLifecycleAction)
}

export function canRetryInstanceLifecycleAction(action: InstanceLifecycleAction, status: string, errorCode = '') {
  if (retryBlockedCodes.has(errorCode)) return false
  if (action === 'start') return status === 'stopped' || status === 'failed'
  return status === 'running' || status === 'degraded'
}

export function instanceLifecycleRequestRecoveryKey(errorCode: string) {
  if (errorCode === 'resource_conflict') return 'instanceActionRequestRecoveryConflict'
  if (errorCode === 'resource_unavailable') return 'instanceActionRequestRecoveryUnavailable'
  if (errorCode === 'forbidden' || errorCode === 'unauthorized') return 'instanceActionRequestRecoveryForbidden'
  if (errorCode === 'not_found') return 'instanceActionRequestRecoveryNotFound'
  return 'instanceActionRequestRecoveryDefault'
}
