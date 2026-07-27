import dayjs, { type Dayjs } from 'dayjs'
import type { Project } from './types'

export function parseLabelText(value?: string): Record<string, string> | undefined {
  const labels: Record<string, string> = {}
  for (const part of String(value || '').split(',')) {
    if (!part.trim()) continue
    const separator = part.indexOf('=')
    const key = (separator >= 0 ? part.slice(0, separator) : part).trim()
    const labelValue = (separator >= 0 ? part.slice(separator + 1) : '').trim()
    if (!key || key.length > 64 || labelValue.length > 255) return undefined
    labels[key] = labelValue || 'true'
  }
  return labels
}

export function labelText(labels?: Record<string, string>): string {
  return Object.entries(labels || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}

export function hasProjectDeploymentDefaults(project?: Project): boolean {
  return !!project && (
    !!project.defaultEnvironment
    || project.defaultExpiryDays !== undefined
    || Object.keys(project.defaultLabels || {}).length > 0
  )
}

export function projectDeploymentValues(project?: Project, now: Dayjs = dayjs()) {
  const expiryDays = project?.defaultExpiryDays ?? 7
  return {
    environment: project?.defaultEnvironment || 'development',
    expiresAt: expiryDays === 0 ? undefined : now.add(expiryDays, 'day').endOf('day'),
    labels: labelText(project?.defaultLabels),
  }
}
