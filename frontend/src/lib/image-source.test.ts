import { describe, expect, it } from 'vitest'
import { imageRegistryHost, isRegistryURL, registryMatchesImage } from './image-source'

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
})
