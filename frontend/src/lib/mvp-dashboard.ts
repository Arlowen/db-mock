import type { Dashboard } from './types'

const abnormalDatabaseStatuses = new Set(['failed', 'degraded'])
const failedTaskStatuses = new Set(['failed', 'interrupted'])

function total(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0)
}

export function mvpDashboardSummary(dashboard?: Dashboard) {
  const hosts = dashboard?.hosts || {}
  const instances = dashboard?.instances || {}
  return {
    hostCount: total(hosts),
    availableHostCount: hosts.online || 0,
    databaseCount: total(instances),
    abnormalDatabaseCount: Object.entries(instances).reduce(
      (sum, [status, count]) => sum + (abnormalDatabaseStatuses.has(status) ? count : 0),
      0,
    ),
    activeTaskCount: dashboard?.activeTasks || 0,
    failedTaskCount: (dashboard?.attentionItems || []).filter(
      (item) => item.taskStatus && failedTaskStatuses.has(item.taskStatus),
    ).length,
  }
}
