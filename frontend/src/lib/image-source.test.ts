import { describe, expect, it } from 'vitest'
import { imageArtifactMatchesTemplate, imageArtifactSupportsAnyArchitecture, imageRegistryHost, imageSourceSelectionReady, isRegistryURL, isSupportedImageArchive, registryMatchesImage, registryMatchesTemplate, templateImageReferences } from './image-source'

describe('image source matching', () => {
  it('resolves Docker Hub shorthand and explicit registries', () => {
    expect(imageRegistryHost('postgres:17')).toBe('docker.io')
    expect(imageRegistryHost('library/postgres:17')).toBe('docker.io')
    expect(imageRegistryHost('ghcr.io/example/postgres:17')).toBe('ghcr.io')
    expect(imageRegistryHost('localhost:5000/example/postgres:17')).toBe('localhost:5000')
  })

  it('only matches credentials for the template image registry', () => {
    expect(registryMatchesImage('https://ghcr.io', 'ghcr.io/example/postgres:17')).toBe(true)
    expect(registryMatchesImage('https://harbor.example.com', 'ghcr.io/example/postgres:17')).toBe(false)
    expect(registryMatchesImage('https://registry-1.docker.io', 'postgres:17')).toBe(true)
  })

  it('accepts internal development registries without allowing paths or embedded credentials', () => {
    expect(isRegistryURL('http://registry:5000')).toBe(true)
    expect(isRegistryURL('https://harbor.internal')).toBe(true)
    expect(isRegistryURL('https://harbor.example.com/')).toBe(true)
    expect(isRegistryURL('https://harbor.example.com/team')).toBe(false)
    expect(isRegistryURL('https://user:secret@harbor.example.com')).toBe(false)
    expect(isRegistryURL('ftp://harbor.example.com')).toBe(false)
  })

  it('requires every image declared by a multi-service template', () => {
    const version = { imageReference: 'registry.example.test/database:1', manifest: {
      imageReferences: ['registry.example.test/database:1', 'registry.example.test/exporter:2', 'registry.example.test/database:1'],
    } }
    expect(templateImageReferences(version)).toEqual(['registry.example.test/database:1', 'registry.example.test/exporter:2'])
    expect(imageArtifactMatchesTemplate(['registry.example.test/database:1'], version)).toBe(false)
    expect(imageArtifactMatchesTemplate(['registry.example.test/database:1', 'registry.example.test/exporter:2'], version)).toBe(true)
    expect(registryMatchesTemplate('https://registry.example.test', version)).toBe(true)
    expect(registryMatchesTemplate('https://docker.io', version)).toBe(false)
  })

  it('rejects one registry when a template spans multiple registry hosts', () => {
    const version = { imageReference: 'registry.example.test/database:1', manifest: {
      imageReferences: ['registry.example.test/database:1', 'ghcr.io/example/exporter:2'],
    } }
    expect(registryMatchesTemplate('https://registry.example.test', version)).toBe(false)
  })

  it('requires an offline archive to support at least one eligible host architecture', () => {
    expect(imageArtifactSupportsAnyArchitecture(['arm64'], ['amd64', 'arm64'])).toBe(true)
    expect(imageArtifactSupportsAnyArchitecture(['arm64'], ['amd64'])).toBe(false)
    expect(imageArtifactSupportsAnyArchitecture([], ['amd64'])).toBe(false)
  })

  it('only allows the wizard to continue when the selected image source is complete', () => {
    expect(imageSourceSelectionReady('public')).toBe(true)
    expect(imageSourceSelectionReady('registry')).toBe(false)
    expect(imageSourceSelectionReady('registry', 'registry-id')).toBe(true)
    expect(imageSourceSelectionReady('offline')).toBe(false)
    expect(imageSourceSelectionReady('offline', undefined, 'image-id')).toBe(true)
    expect(imageSourceSelectionReady('unknown')).toBe(false)
  })

  it('accepts only supported offline image archive filenames', () => {
    expect(isSupportedImageArchive('postgres-17.tar')).toBe(true)
    expect(isSupportedImageArchive('postgres-17.tar.gz')).toBe(true)
    expect(isSupportedImageArchive('postgres-17.TGZ')).toBe(true)
    expect(isSupportedImageArchive('postgres-17.zip')).toBe(false)
    expect(isSupportedImageArchive('postgres-17.tar.gz.txt')).toBe(false)
    expect(isSupportedImageArchive('')).toBe(false)
  })
})
