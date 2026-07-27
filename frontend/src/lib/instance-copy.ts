import type { Instance, TemplateParameterValue } from './types'

export type DeploymentImageSource = 'public' | 'registry' | 'offline'

export interface DeploymentCopyDraft {
  name: string
  projectId?: string
  environment: string
  purpose?: string
  templateVersionId: string
  hostId?: string
  cpu: number
  memoryGiB: number
  diskGiB: number
  hostPort?: number
  bindAddress: string
  username?: string
  password?: string
  databaseName?: string
  autoRestart: boolean
  imageSource: DeploymentImageSource
  imageArtifactId?: string
  registryId?: string
  labels?: string
  extraEnvironment?: string
  templateParameters?: Record<string, TemplateParameterValue>
}

function stringMapText(values: Record<string, string> | undefined) {
  if (!values || Object.keys(values).length === 0) return ''
  return JSON.stringify(values, null, 2)
}

function labelText(values: Record<string, string> | undefined) {
  return Object.entries(values || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}

export function deploymentCopyDraft(instance: Instance, availableProjectIDs?: Iterable<string>): DeploymentCopyDraft {
  const configuration = instance.configuration || {}
  const imageArtifactId = configuration.imageArtifactId || undefined
  const registryId = configuration.registryId || undefined
  const imageSource: DeploymentImageSource = imageArtifactId ? 'offline' : registryId ? 'registry' : 'public'
  const projects = availableProjectIDs ? new Set(availableProjectIDs) : undefined
  const projectId = instance.projectId && (!projects || projects.has(instance.projectId)) ? instance.projectId : undefined

  return {
    name: '',
    projectId,
    environment: instance.environment,
    purpose: instance.purpose,
    templateVersionId: instance.templateVersionId,
    hostId: undefined,
    cpu: instance.cpu,
    memoryGiB: instance.memoryBytes / 1024 ** 3,
    diskGiB: instance.reservedDiskBytes / 1024 ** 3,
    hostPort: undefined,
    bindAddress: instance.bindAddress,
    username: instance.databaseUsername,
    password: undefined,
    databaseName: instance.databaseName,
    autoRestart: instance.autoRestart,
    imageSource,
    imageArtifactId: imageSource === 'offline' ? imageArtifactId : undefined,
    registryId: imageSource === 'registry' ? registryId : undefined,
    labels: labelText(instance.labels),
    extraEnvironment: stringMapText(configuration.extraEnvironment),
    templateParameters: { ...(configuration.templateParameters || {}) },
  }
}
