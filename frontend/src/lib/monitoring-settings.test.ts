import { describe, expect, it } from 'vitest'
import { defaultMonitoringSettings, normalizeMonitoringSettings } from './monitoring-settings'

describe('monitoring settings', () => {
  it('backfills alert switches for settings created by older versions', () => {
    const policy = normalizeMonitoringSettings({ intervalSeconds: 60, diskWarningPercent: 70 })
    expect(policy.intervalSeconds).toBe(60)
    expect(policy.diskWarningPercent).toBe(70)
    expect(policy.alerts).toEqual(defaultMonitoringSettings.alerts)
  })

  it('preserves explicit disabled alert types', () => {
    const policy = normalizeMonitoringSettings({ alerts: { hostOffline: false, upgradeFailed: false } })
    expect(policy.alerts.hostOffline).toBe(false)
    expect(policy.alerts.upgradeFailed).toBe(false)
    expect(policy.alerts.sshCredentialInvalid).toBe(true)
  })
})
