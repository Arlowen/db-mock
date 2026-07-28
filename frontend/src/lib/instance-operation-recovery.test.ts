import { describe, expect, it } from 'vitest'
import {
  canRetryInstanceLifecycleAction,
  instanceLifecycleRequestRecoveryKey,
  isInstanceLifecycleAction,
} from './instance-operation-recovery'

describe('instance lifecycle request recovery', () => {
  it('limits the persistent recovery flow to frequent lifecycle actions', () => {
    for (const action of ['start', 'stop', 'restart']) expect(isInstanceLifecycleAction(action)).toBe(true)
    for (const action of ['delete', 'upgrade', 'reconfigure']) expect(isInstanceLifecycleAction(action)).toBe(false)
  })

  it('offers retry only when the refreshed status safely allows the same action', () => {
    expect(canRetryInstanceLifecycleAction('start', 'stopped')).toBe(true)
    expect(canRetryInstanceLifecycleAction('start', 'failed')).toBe(true)
    expect(canRetryInstanceLifecycleAction('restart', 'running')).toBe(true)
    expect(canRetryInstanceLifecycleAction('stop', 'degraded')).toBe(true)
    expect(canRetryInstanceLifecycleAction('restart', 'restarting')).toBe(false)
    expect(canRetryInstanceLifecycleAction('stop', 'running', 'forbidden')).toBe(false)
  })

  it('selects recovery guidance from stable API error codes', () => {
    expect(instanceLifecycleRequestRecoveryKey('resource_conflict')).toBe('instanceActionRequestRecoveryConflict')
    expect(instanceLifecycleRequestRecoveryKey('resource_unavailable')).toBe('instanceActionRequestRecoveryUnavailable')
    expect(instanceLifecycleRequestRecoveryKey('forbidden')).toBe('instanceActionRequestRecoveryForbidden')
    expect(instanceLifecycleRequestRecoveryKey('not_found')).toBe('instanceActionRequestRecoveryNotFound')
    expect(instanceLifecycleRequestRecoveryKey('internal_error')).toBe('instanceActionRequestRecoveryDefault')
  })
})
