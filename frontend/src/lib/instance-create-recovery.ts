export type InstanceCreateContextStatus = 'checking' | 'ready' | 'failed'

export type InstanceCreateRequestFailure = {
  code: string
  message: string
  serverRejected: boolean
  contextStatus: InstanceCreateContextStatus
  existingInstanceId?: string
  existingInstanceName?: string
}

const retryBlockedCodes = new Set(['forbidden', 'unauthorized', 'not_found', 'invalid_input'])

export function canRetryInstanceCreateRequest({
  serverRejected,
  contextStatus,
  code,
  draftReady,
  existingInstanceId,
}: Pick<InstanceCreateRequestFailure, 'serverRejected' | 'contextStatus' | 'code' | 'existingInstanceId'> & {
  draftReady: boolean
}) {
  return serverRejected &&
    contextStatus === 'ready' &&
    draftReady &&
    !existingInstanceId &&
    !retryBlockedCodes.has(code)
}

export function instanceCreateRecoveryKey({
  code,
  serverRejected,
  existingInstanceId,
}: Pick<InstanceCreateRequestFailure, 'code' | 'serverRejected' | 'existingInstanceId'>) {
  if (existingInstanceId) return 'instanceCreateRecoveryExisting'
  if (!serverRejected) return 'instanceCreateRecoveryAmbiguous'
  if (code === 'resource_conflict') return 'instanceCreateRecoveryConflict'
  if (code === 'resource_unavailable') return 'instanceCreateRecoveryUnavailable'
  if (code === 'forbidden' || code === 'unauthorized') return 'instanceCreateRecoveryForbidden'
  if (code === 'not_found') return 'instanceCreateRecoveryNotFound'
  if (code === 'invalid_input') return 'instanceCreateRecoveryInvalid'
  return 'instanceCreateRecoveryDefault'
}
