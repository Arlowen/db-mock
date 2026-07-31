import { describe, expect, it } from 'vitest'
import {
  canRetryInstanceChangeRequest,
  instanceChangeRequestImpactKey,
  instanceChangeRequestRecoveryKey,
  isInstanceChangeRequestAction,
} from './instance-change-request-recovery'

describe('instance change request recovery', () => {
  it('recognizes only upgrade and runtime reconfiguration requests', () => {
    expect(isInstanceChangeRequestAction('upgrade')).toBe(true)
    expect(isInstanceChangeRequestAction('reconfigure')).toBe(true)
    expect(isInstanceChangeRequestAction('restart')).toBe(false)
  })

  it('allows a retry only while the instance remains changeable and no task is active', () => {
    expect(canRetryInstanceChangeRequest('upgrade', 'running')).toBe(true)
    expect(canRetryInstanceChangeRequest('reconfigure', 'stopped', 'resource_unavailable')).toBe(true)
    expect(canRetryInstanceChangeRequest('reconfigure', 'degraded', 'resource_conflict')).toBe(true)
    expect(canRetryInstanceChangeRequest('upgrade', 'running', 'resource_conflict', true)).toBe(false)
    expect(canRetryInstanceChangeRequest('upgrade', 'upgrading')).toBe(false)
    expect(canRetryInstanceChangeRequest('reconfigure', 'running', 'forbidden')).toBe(false)
    expect(canRetryInstanceChangeRequest('upgrade', 'stopped', 'not_found')).toBe(false)
  })

  it('maps stable error and impact guidance keys', () => {
    expect(instanceChangeRequestRecoveryKey('resource_conflict')).toBe('instanceChangeRequestRecoveryConflict')
    expect(instanceChangeRequestRecoveryKey('resource_unavailable')).toBe('instanceChangeRequestRecoveryUnavailable')
    expect(instanceChangeRequestRecoveryKey('forbidden')).toBe('instanceChangeRequestRecoveryForbidden')
    expect(instanceChangeRequestRecoveryKey('not_found')).toBe('instanceChangeRequestRecoveryNotFound')
    expect(instanceChangeRequestRecoveryKey('internal_error')).toBe('instanceChangeRequestRecoveryDefault')
    expect(instanceChangeRequestImpactKey('upgrade')).toBe('instanceChangeRequestImpact_upgrade')
    expect(instanceChangeRequestImpactKey('reconfigure')).toBe('instanceChangeRequestImpact_reconfigure')
  })
})
