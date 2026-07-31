export type InstanceChangeRequestAction = 'upgrade' | 'reconfigure'

export interface InstanceChangeRequestFailure {
  action: InstanceChangeRequestAction
  code: string
  message: string
}

const changeRequestActions = new Set<InstanceChangeRequestAction>(['upgrade', 'reconfigure'])
const retryBlockedCodes = new Set(['forbidden', 'unauthorized', 'not_found'])
const changeableStatuses = new Set(['running', 'stopped', 'degraded'])

export function isInstanceChangeRequestAction(action: string): action is InstanceChangeRequestAction {
  return changeRequestActions.has(action as InstanceChangeRequestAction)
}

export function canRetryInstanceChangeRequest(action: InstanceChangeRequestAction, status: string,
  errorCode = '', hasActiveTask = false) {
  return changeRequestActions.has(action) && changeableStatuses.has(status)
    && !retryBlockedCodes.has(errorCode) && !hasActiveTask
}

export function instanceChangeRequestRecoveryKey(errorCode: string) {
  if (errorCode === 'resource_conflict') return 'instanceChangeRequestRecoveryConflict'
  if (errorCode === 'resource_unavailable') return 'instanceChangeRequestRecoveryUnavailable'
  if (errorCode === 'forbidden' || errorCode === 'unauthorized') return 'instanceChangeRequestRecoveryForbidden'
  if (errorCode === 'not_found') return 'instanceChangeRequestRecoveryNotFound'
  return 'instanceChangeRequestRecoveryDefault'
}

export function instanceChangeRequestImpactKey(action: InstanceChangeRequestAction) {
  return `instanceChangeRequestImpact_${action}`
}
