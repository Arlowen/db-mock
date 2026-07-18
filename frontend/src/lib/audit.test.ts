import { describe, expect, it } from 'vitest'
import { auditChangeEntries, auditResourcePath, auditValueText } from './audit'

describe('audit helpers', () => {
  it('formats transitions and redacts nested secrets defensively', () => {
    expect(auditChangeEntries({
      status: { from: 'active', to: 'disabled' },
      passwordChanged: true,
      connection: { token: 'plain-token', host: 'db.internal' },
    })).toEqual([
      { key: 'status', before: 'active', after: 'disabled' },
      { key: 'passwordChanged', value: true },
      { key: 'connection', value: { token: '[REDACTED]', host: 'db.internal' } },
    ])
  })

  it('links supported audit resources into their working views', () => {
    expect(auditResourcePath({ resourceType: 'instance', resourceId: 'instance-id' })).toBe('/instances/instance-id')
    expect(auditResourcePath({ resourceType: 'host', resourceId: 'host-id' })).toBe('/hosts?host=host-id')
    expect(auditResourcePath({ resourceType: 'webhook', resourceId: 'webhook-id' })).toBe('/alerts?tab=webhooks&webhook=webhook-id')
    expect(auditResourcePath({ resourceType: 'platform' })).toBe('')
  })

  it('renders structured values without losing their contents', () => {
    expect(auditValueText({ host: 'db.internal' })).toBe('{"host":"db.internal"}')
    expect(auditValueText(undefined)).toBe('—')
  })
})
