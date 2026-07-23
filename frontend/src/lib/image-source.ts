import type { TemplateVersion } from './types'

function normalizeRegistryHost(value: string): string {
  const normalized = value.toLowerCase().replace(/\/$/, '')
  return ['index.docker.io', 'registry-1.docker.io'].includes(normalized) ? 'docker.io' : normalized
}

export function imageRegistryHost(reference: string): string {
  const parts = reference.trim().replace(/^docker:\/\//, '').split('/')
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) return normalizeRegistryHost(parts[0])
  return 'docker.io'
}

export function registryHost(registryURL: string): string {
  try { return normalizeRegistryHost(new URL(registryURL).host) } catch { return '' }
}

export function isRegistryURL(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname &&
      (parsed.pathname === '' || parsed.pathname === '/') && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

export function registryMatchesImage(registryURL: string, imageReference: string): boolean {
  return registryHost(registryURL) === imageRegistryHost(imageReference)
}

export function templateImageReferences(version: Pick<TemplateVersion, 'imageReference' | 'manifest'>): string[] {
  const declared = Array.isArray(version.manifest?.imageReferences)
    ? version.manifest.imageReferences.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim())
    : []
  return [...new Set([version.imageReference.trim(), ...declared].filter(Boolean))]
}

export function imageArtifactMatchesTemplate(imageReferences: string[], version: Pick<TemplateVersion, 'imageReference' | 'manifest'>): boolean {
  return templateImageReferences(version).every((reference) => imageReferences.includes(reference))
}

export function imageArtifactSupportsAnyArchitecture(imageArchitectures: string[], targetArchitectures: string[]): boolean {
  return targetArchitectures.some((architecture) => imageArchitectures.includes(architecture))
}

export function imageSourceSelectionReady(source: string, registryID?: string, imageArtifactID?: string): boolean {
  if (source === 'public') return true
  if (source === 'registry') return !!registryID
  if (source === 'offline') return !!imageArtifactID
  return false
}

export function registryMatchesTemplate(registryURL: string, version: Pick<TemplateVersion, 'imageReference' | 'manifest'>): boolean {
  return templateImageReferences(version).every((reference) => registryMatchesImage(registryURL, reference))
}
