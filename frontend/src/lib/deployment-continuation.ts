import { imageArtifactMatchesTemplate, imageArtifactSupportsAnyArchitecture } from './image-source'
import type { DatabaseTemplate, Host, ImageArtifact, Instance, TemplateVersion } from './types'

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
    imageName?: string
  }

export function safeCreateReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith('/')) return ''
  try {
    const parsed = new URL(value, continuationOrigin)
    if (parsed.origin !== continuationOrigin || parsed.pathname !== '/instances' || parsed.searchParams.get('create') !== '1') return ''
    return `${parsed.pathname}?${parsed.searchParams.toString()}`
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
  instances: Instance[],
  images: ImageArtifact[],
): DeploymentContinuationRequirement {
  const safePath = safeCreateReturnPath(value)
  if (!safePath) return { status: 'unresolved', architectures: [] }

  const parsed = new URL(safePath, continuationOrigin)
  const copyID = parsed.searchParams.get('copy')?.trim()
  const templateVersionID = parsed.searchParams.get('template')?.trim()
  if (!copyID && !templateVersionID) return { status: 'unconstrained', architectures: [] }

  const source = copyID ? instances.find((instance) => instance.id === copyID) : undefined
  if (copyID && !source) return { status: 'unresolved', architectures: [] }

  const match = findTemplateVersion(templates, source?.templateVersionId || templateVersionID || '')
  if (!match) return { status: 'unresolved', architectures: [] }

  let architectures = normalizedArchitectures(match.version.architectures)
  const imageID = !copyID ? parsed.searchParams.get('image')?.trim() : ''
  const image = imageID ? images.find((candidate) => candidate.id === imageID) : undefined
  const imageAvailable = !!image &&
    image.status === 'ready' &&
    imageArtifactMatchesTemplate(image.imageRefs, match.version) &&
    imageArtifactSupportsAnyArchitecture(image.architectures, architectures)
  if (imageAvailable) {
    const imageArchitectures = new Set(normalizedArchitectures(image.architectures))
    architectures = architectures.filter((architecture) => imageArchitectures.has(architecture))
  }

  if (architectures.length === 0) return { status: 'unresolved', architectures: [] }
  return {
    status: 'resolved',
    architectures,
    templateName: match.template.name,
    templateNameZh: match.template.nameZh,
    templateVersion: match.version.version,
    imageName: imageAvailable ? image.name : undefined,
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
