import { describe, expect, it } from 'vitest'
import { dashboardAttentionCanRetry, dashboardAttentionGuidance, dashboardAttentionResourcePath } from './dashboard-attention'
import type { DashboardAttentionItem } from './types'

const item: DashboardAttentionItem = {
  resourceType: 'instance',
  resourceId: 'instance-id',
  resourceName: 'Orders DB',
  resourceStatus: 'failed',
  hostName: 'test-host',
  taskId: 'task-id',
  taskKind: 'instance.create',
  taskStatus: 'failed',
  errorCode: 'ssh_unreachable',
  updatedAt: '2026-07-27T12:00:00Z',
}

describe('dashboard attention helpers', () => {
  it('reuses classified task guidance and exposes the instance destination', () => {
    expect(dashboardAttentionGuidance(item)).toEqual({
      causeKey: 'taskFailureCause_ssh_unreachable',
      recoveryKey: 'taskFailureRecovery_ssh_unreachable',
      inspectHost: true,
    })
    expect(dashboardAttentionResourcePath(item)).toBe('/instances/instance-id')
    expect(dashboardAttentionCanRetry(item)).toBe(true)
  })

  it('uses resource recovery guidance when no unresolved task exists', () => {
    expect(dashboardAttentionGuidance({ ...item, taskId: undefined, taskKind: undefined, taskStatus: undefined, resourceStatus: 'degraded' })).toEqual({
      causeKey: 'attentionInstanceCause_degraded',
      recoveryKey: 'attentionInstanceRecovery_degraded',
      inspectHost: false,
    })
  })

  it('links hosts but does not offer retry for a current-state exception', () => {
    const host = { ...item, resourceType: 'host', taskId: undefined, taskStatus: undefined }
    expect(dashboardAttentionResourcePath(host)).toBe('/hosts?host=instance-id')
    expect(dashboardAttentionCanRetry(host)).toBe(false)
  })
})
