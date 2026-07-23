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

export function isMonitoringSettingsValid(value: unknown): value is MonitoringSettings {
  const source = record(value)
  const alerts = record(source.alerts)
  const intervalSeconds = source.intervalSeconds
  const retentionDays = source.retentionDays
  const diskWarningPercent = source.diskWarningPercent
  const diskCriticalPercent = source.diskCriticalPercent
  return typeof intervalSeconds === 'number'
    && Number.isInteger(intervalSeconds)
    && intervalSeconds >= 5
    && intervalSeconds <= 3600
    && typeof retentionDays === 'number'
    && Number.isInteger(retentionDays)
    && retentionDays >= 1
    && retentionDays <= 365
    && typeof diskWarningPercent === 'number'
    && diskWarningPercent >= 1
    && diskWarningPercent <= 99
    && typeof diskCriticalPercent === 'number'
    && diskCriticalPercent >= 2
    && diskCriticalPercent <= 100
    && diskCriticalPercent > diskWarningPercent
    && monitoringAlertKeys.every((key) => typeof alerts[key] === 'boolean')
}
