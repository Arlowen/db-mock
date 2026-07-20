export const monitoringAlertKeys = [
  'hostOffline',
  'sshCredentialInvalid',
  'containerExited',
  'containerUnhealthy',
  'restartFailed',
  'diskWarning',
  'diskCritical',
  'upgradeFailed',
] as const

export type MonitoringAlertKey = typeof monitoringAlertKeys[number]

export interface MonitoringSettings {
  intervalSeconds: number
  retentionDays: number
  diskWarningPercent: number
  diskCriticalPercent: number
  alerts: Record<MonitoringAlertKey, boolean>
}

export const defaultMonitoringSettings: MonitoringSettings = {
  intervalSeconds: 30,
  retentionDays: 7,
  diskWarningPercent: 80,
  diskCriticalPercent: 90,
  alerts: {
    hostOffline: true,
    sshCredentialInvalid: true,
    containerExited: true,
    containerUnhealthy: true,
    restartFailed: true,
    diskWarning: true,
    diskCritical: true,
    upgradeFailed: true,
  },
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeMonitoringSettings(value: unknown): MonitoringSettings {
  const source = record(value)
  const configuredAlerts = record(source.alerts)
  const alerts = { ...defaultMonitoringSettings.alerts }
  for (const key of monitoringAlertKeys) {
    if (typeof configuredAlerts[key] === 'boolean') alerts[key] = configuredAlerts[key]
  }
  return {
    intervalSeconds: finiteNumber(source.intervalSeconds, defaultMonitoringSettings.intervalSeconds),
    retentionDays: finiteNumber(source.retentionDays, defaultMonitoringSettings.retentionDays),
    diskWarningPercent: finiteNumber(source.diskWarningPercent, defaultMonitoringSettings.diskWarningPercent),
    diskCriticalPercent: finiteNumber(source.diskCriticalPercent, defaultMonitoringSettings.diskCriticalPercent),
    alerts,
  }
}
