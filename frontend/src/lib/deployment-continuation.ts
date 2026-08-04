import type { DatabaseTemplate, Host, TemplateVersion } from './types'

const continuationOrigin = 'https://dbmock.invalid'

export type DeploymentContinuationRequirement =
  | { status: 'unconstrained'; architectures: string[] }
  | { status: 'unresolved'; architectures: string[] }
  | {
    status: 'resolved'
    architectures: string[]
    templateName: string
    templateNameZh: string
    templateVersion: string
  }

export function safeCreateReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith('/')) return ''
  try {
    const parsed = new URL(value, continuationOrigin)
    if (parsed.origin !== continuationOrigin || parsed.pathname !== '/instances' || parsed.searchParams.get('create') !== '1') return ''
    const safe = new URLSearchParams({ create: '1' })
    const template = parsed.searchParams.get('template')?.trim()
    const host = parsed.searchParams.get('host')?.trim()
    if (template) safe.set('template', template)
    if (host) safe.set('host', host)
    return `${parsed.pathname}?${safe.toString()}`
  } catch {
    return ''
  }
}

export function deploymentReturnPathForHost(value: string | null | undefined, hostId: string | null | undefined): string {
  const safePath = safeCreateReturnPath(value)
  if (!safePath) return ''
  const normalizedHostId = hostId?.trim()
  if (!normalizedHostId) return safePath
  const parsed = new URL(safePath, continuationOrigin)
  parsed.searchParams.set('host', normalizedHostId)
  return `${parsed.pathname}?${parsed.searchParams.toString()}`
}

function normalizedArchitectures(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}

function findTemplateVersion(templates: DatabaseTemplate[], versionID: string): { template: DatabaseTemplate; version: TemplateVersion } | undefined {
  for (const template of templates) {
    const version = template.versions.find((candidate) => candidate.id === versionID && candidate.selectable !== false)
    if (version) return { template, version }
  }
  return undefined
}

export function deploymentContinuationRequirement(
  value: string | null | undefined,
  templates: DatabaseTemplate[],
): DeploymentContinuationRequirement {
  const safePath = safeCreateReturnPath(value)
  if (!safePath) return { status: 'unresolved', architectures: [] }

  const parsed = new URL(safePath, continuationOrigin)
  const templateVersionID = parsed.searchParams.get('template')?.trim()
  if (!templateVersionID) return { status: 'unconstrained', architectures: [] }

  const match = findTemplateVersion(templates, templateVersionID)
  if (!match) return { status: 'unresolved', architectures: [] }

  const architectures = normalizedArchitectures(match.version.architectures)
  if (architectures.length === 0) return { status: 'unresolved', architectures: [] }
  return {
    status: 'resolved',
    architectures,
    templateName: match.template.name,
    templateNameZh: match.template.nameZh,
    templateVersion: match.version.version,
  }
}

export function hostMeetsDeploymentRequirement(
  host: Pick<Host, 'architecture'>,
  requirement: DeploymentContinuationRequirement,
): boolean {
  if (requirement.status === 'unconstrained') return true
  if (requirement.status !== 'resolved') return false
  return requirement.architectures.includes((host.architecture || '').trim().toLowerCase())
}
