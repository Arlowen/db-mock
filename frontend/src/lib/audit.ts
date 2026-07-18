import type { Audit } from './types'

export interface AuditChangeEntry {
  key: string
  before?: unknown
  after?: unknown
  value?: unknown
}

const redacted = '[REDACTED]'

function sensitiveAuditKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[_\- .]/g, '')
  return ['password', 'secret', 'token', 'credential', 'privatekey', 'passphrase', 'authorization', 'cookie', 'connectionuri', 'jdbcuri'].some((fragment) => normalized.includes(fragment))
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (sensitiveAuditKey(key) && typeof value !== 'boolean') return redacted
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey)]))
  }
  return value
}

export function auditChangeEntries(changes: Record<string, unknown> | undefined): AuditChangeEntry[] {
  if (!changes) return []
  return Object.entries(changes).map(([key, raw]) => {
    const value = sanitizeValue(raw, key)
    if (value && typeof value === 'object' && !Array.isArray(value) && 'from' in value && 'to' in value) {
      const transition = value as Record<string, unknown>
      return { key, before: transition.from, after: transition.to }
    }
    return { key, value }
  })
}

export function auditResourcePath(item: Pick<Audit, 'resourceType' | 'resourceId'>): string {
  switch (item.resourceType) {
    case 'host': return item.resourceId ? `/hosts?host=${item.resourceId}` : '/hosts'
    case 'instance': return item.resourceId ? `/instances/${item.resourceId}` : '/instances'
    case 'task': return item.resourceId ? `/tasks?task=${item.resourceId}` : '/tasks'
    case 'alert': return item.resourceId ? `/alerts?alert=${item.resourceId}` : '/alerts'
    case 'webhook': return item.resourceId ? `/alerts?tab=webhooks&webhook=${item.resourceId}` : '/alerts?tab=webhooks'
    case 'image': case 'image_upload': case 'registry': return item.resourceType === 'registry' ? '/images?tab=registries' : '/images'
    case 'template': return '/catalog'
    case 'project': return '/projects'
    case 'user': return '/users'
    case 'setting': return '/settings'
    default: return ''
  }
}

export function auditValueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

export function isRedactedAuditValue(value: unknown): boolean {
  return value === redacted
}
