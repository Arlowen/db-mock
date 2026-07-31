import { describe, expect, it } from 'vitest'
import { canRetryInstanceCreateRequest, instanceCreateRecoveryKey } from './instance-create-recovery'

describe('instance create request recovery', () => {
  it('retries a confirmed rejection only after current deployment data is ready', () => {
    expect(canRetryInstanceCreateRequest({
      serverRejected: true,
      contextStatus: 'ready',
      code: 'resource_conflict',
      draftReady: true,
    })).toBe(true)
    expect(canRetryInstanceCreateRequest({
      serverRejected: true,
      contextStatus: 'checking',
      code: 'resource_conflict',
      draftReady: true,
    })).toBe(false)
    expect(canRetryInstanceCreateRequest({
      serverRejected: true,
      contextStatus: 'ready',
      code: 'resource_conflict',
      draftReady: false,
    })).toBe(false)
  })

  it('never retries an ambiguous request or a request whose matching instance now exists', () => {
    expect(canRetryInstanceCreateRequest({
      serverRejected: false,
      contextStatus: 'ready',
      code: 'network_error',
      draftReady: true,
    })).toBe(false)
    expect(canRetryInstanceCreateRequest({
      serverRejected: true,
      contextStatus: 'ready',
      code: 'resource_conflict',
      draftReady: true,
      existingInstanceId: 'instance-1',
    })).toBe(false)
  })

  it('blocks retries that require authority or corrected configuration', () => {
    for (const code of ['forbidden', 'unauthorized', 'not_found', 'invalid_input']) {
      expect(canRetryInstanceCreateRequest({
        serverRejected: true,
        contextStatus: 'ready',
        code,
        draftReady: true,
      })).toBe(false)
    }
  })

  it('selects recovery guidance from response certainty and stable API codes', () => {
    expect(instanceCreateRecoveryKey({
      code: 'resource_conflict', serverRejected: true,
    })).toBe('instanceCreateRecoveryConflict')
    expect(instanceCreateRecoveryKey({
      code: 'resource_unavailable', serverRejected: true,
    })).toBe('instanceCreateRecoveryUnavailable')
    expect(instanceCreateRecoveryKey({
      code: 'forbidden', serverRejected: true,
    })).toBe('instanceCreateRecoveryForbidden')
    expect(instanceCreateRecoveryKey({
      code: 'not_found', serverRejected: true,
    })).toBe('instanceCreateRecoveryNotFound')
    expect(instanceCreateRecoveryKey({
      code: 'invalid_input', serverRejected: true,
    })).toBe('instanceCreateRecoveryInvalid')
    expect(instanceCreateRecoveryKey({
      code: 'network_error', serverRejected: false,
    })).toBe('instanceCreateRecoveryAmbiguous')
    expect(instanceCreateRecoveryKey({
      code: 'resource_conflict', serverRejected: true, existingInstanceId: 'instance-1',
    })).toBe('instanceCreateRecoveryExisting')
    expect(instanceCreateRecoveryKey({
      code: 'internal_error', serverRejected: true,
    })).toBe('instanceCreateRecoveryDefault')
  })
})
