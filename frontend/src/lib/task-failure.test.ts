import { describe, expect, it } from 'vitest'
import { taskFailureGuidance } from './task-failure'

describe('taskFailureGuidance', () => {
  it('maps a classified host failure to actionable host recovery', () => {
    expect(taskFailureGuidance({ kind: 'instance.restart', errorCode: 'ssh_unreachable' })).toEqual({
      causeKey: 'taskFailureCause_ssh_unreachable',
      impactKey: 'taskFailureImpact_instance_restart',
      recoveryKey: 'taskFailureRecovery_ssh_unreachable',
      inspectHost: true,
    })
  })

  it('keeps database health failures focused on the affected instance', () => {
    expect(taskFailureGuidance({ kind: 'instance.create', errorCode: 'health_check_failed' })).toEqual({
      causeKey: 'taskFailureCause_health_check_failed',
      impactKey: 'taskFailureImpact_instance_create',
      recoveryKey: 'taskFailureRecovery_health_check_failed',
      inspectHost: false,
    })
  })

  it('falls back safely for historical or unknown error codes', () => {
    expect(taskFailureGuidance({ kind: 'custom.task', errorCode: 'unrecognized_failure' })).toEqual({
      causeKey: 'taskFailureCause_task_failed',
      impactKey: 'taskFailureImpact_generic',
      recoveryKey: 'taskFailureRecovery_task_failed',
      inspectHost: false,
    })
  })

  it('supports legacy underscore task kinds', () => {
    expect(taskFailureGuidance({ kind: 'instance_backup', errorCode: 'operation_timeout' }).impactKey)
      .toBe('taskFailureImpact_instance_backup')
  })
})
