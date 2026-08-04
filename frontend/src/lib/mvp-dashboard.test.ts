import { describe, expect, it } from 'vitest'
import { mvpDashboardSummary } from './mvp-dashboard'
import type { Dashboard } from './types'

const dashboard: Dashboard = {
  hosts: { online: 2, offline: 1 },
  instances: { running: 4, stopped: 2, degraded: 1, failed: 2, provisioning: 1 },
  activeTasks: 3,
  openAlerts: 7,
  users: 4,
  projects: 5,
  attentionItems: [
    { resourceType: 'instance', resourceId: 'one', resourceName: 'one', resourceStatus: 'failed', taskStatus: 'failed', updatedAt: '2026-08-04T00:00:00Z' },
    { resourceType: 'host', resourceId: 'two', resourceName: 'two', resourceStatus: 'offline', taskStatus: 'interrupted', updatedAt: '2026-08-04T00:00:00Z' },
    { resourceType: 'instance', resourceId: 'three', resourceName: 'three', resourceStatus: 'degraded', updatedAt: '2026-08-04T00:00:00Z' },
  ],
  lifecycleInstances: [],
}

describe('MVP dashboard summary', () => {
  it('reports only host, database, and task signals used by the MVP workbench', () => {
    expect(mvpDashboardSummary(dashboard)).toEqual({
      hostCount: 3,
      availableHostCount: 2,
      databaseCount: 10,
      abnormalDatabaseCount: 3,
      activeTaskCount: 3,
      failedTaskCount: 2,
    })
  })

  it('uses stable zero values before dashboard data loads', () => {
    expect(mvpDashboardSummary()).toEqual({
      hostCount: 0,
      availableHostCount: 0,
      databaseCount: 0,
      abnormalDatabaseCount: 0,
      activeTaskCount: 0,
      failedTaskCount: 0,
    })
  })
})
