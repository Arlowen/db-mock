import { describe, expect, it } from 'vitest'
import { defaultMonitoringSettings, isMonitoringSettingsValid, normalizeMonitoringSettings } from './monitoring-settings'

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

  it('only marks complete policies with safe threshold ordering as valid', () => {
    expect(isMonitoringSettingsValid(defaultMonitoringSettings)).toBe(true)
    expect(isMonitoringSettingsValid({ ...defaultMonitoringSettings, diskCriticalPercent: 70 })).toBe(false)
    expect(isMonitoringSettingsValid({ ...defaultMonitoringSettings, intervalSeconds: 5.5 })).toBe(false)
    expect(isMonitoringSettingsValid({ ...defaultMonitoringSettings, alerts: { hostOffline: true } })).toBe(false)
  })
})
