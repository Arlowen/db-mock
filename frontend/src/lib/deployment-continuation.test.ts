import { describe, expect, it } from 'vitest'
import {
  deploymentContinuationRequirement,
  deploymentReturnPathForHost,
  hostMeetsDeploymentRequirement,
  safeCreateReturnPath,
} from './deployment-continuation'
import type { DatabaseTemplate, ImageArtifact, Instance } from './types'

const templates = [{
  id: 'template-1',
  slug: 'example',
  name: 'Example DB',
  nameZh: '示例数据库',
  description: '',
  category: 'relational',
  tier: 'standard',
  builtin: true,
  icon: '',
  riskReport: [],
  versions: [
    {
      id: 'version-dual',
      templateId: 'template-1',
      version: '17',
      imageReference: 'example/db:17',
      architectures: ['amd64', 'arm64'],
      minCpu: 1,
      minMemoryBytes: 1024,
      minDiskBytes: 1024,
      defaultPort: 5432,
      manifest: {},
      riskReport: [],
      createdAt: '',
    },
    {
      id: 'version-amd',
      templateId: 'template-1',
      version: '16',
      imageReference: 'example/db:16',
      architectures: ['amd64'],
      minCpu: 1,
      minMemoryBytes: 1024,
      minDiskBytes: 1024,
      defaultPort: 5432,
      manifest: {},
      riskReport: [],
      createdAt: '',
    },
  ],
}] satisfies DatabaseTemplate[]

const copySource = {
  id: 'instance-1',
  templateVersionId: 'version-amd',
} as Instance

const armImage = {
  id: 'image-arm',
  name: 'ARM offline archive',
  imageRefs: ['example/db:17'],
  architectures: ['arm64'],
  status: 'ready',
} as ImageArtifact

describe('deployment continuation', () => {
  it('accepts only the database creation route', () => {
    expect(safeCreateReturnPath('/instances?create=1&template=version-1')).toBe('/instances?create=1&template=version-1')
    expect(safeCreateReturnPath('/instances?create=0')).toBe('')
    expect(safeCreateReturnPath('/instances?create=1evil')).toBe('')
    expect(safeCreateReturnPath('/tasks?create=1')).toBe('')
    expect(safeCreateReturnPath('//example.test/instances?create=1')).toBe('')
    expect(safeCreateReturnPath('https://example.test/instances?create=1')).toBe('')
  })

  it('adds the connected host without dropping creation context', () => {
    expect(deploymentReturnPathForHost(
      '/instances?create=1&template=version-1&project=project-1&image=image-1',
      ' host-1 ',
    )).toBe('/instances?create=1&template=version-1&project=project-1&image=image-1&host=host-1')
  })

  it('keeps a safe continuation unchanged when no host is selected', () => {
    expect(deploymentReturnPathForHost('/instances?create=1&copy=instance-1', '')).toBe('/instances?create=1&copy=instance-1')
    expect(deploymentReturnPathForHost('/catalog', 'host-1')).toBe('')
  })

  it('resolves the selected template architecture and labels', () => {
    expect(deploymentContinuationRequirement(
      '/instances?create=1&template=version-amd',
      templates,
      [],
      [],
    )).toEqual({
      status: 'resolved',
      architectures: ['amd64'],
      templateName: 'Example DB',
      templateNameZh: '示例数据库',
      templateVersion: '16',
      imageName: undefined,
    })
  })

  it('uses the source instance template for copy deployment', () => {
    const requirement = deploymentContinuationRequirement(
      '/instances?create=1&copy=instance-1',
      templates,
      [copySource],
      [],
    )
    expect(requirement.status).toBe('resolved')
    expect(requirement.architectures).toEqual(['amd64'])
    expect(hostMeetsDeploymentRequirement({ architecture: 'arm64' }, requirement)).toBe(false)
    expect(hostMeetsDeploymentRequirement({ architecture: 'AMD64' }, requirement)).toBe(true)
  })

  it('narrows a dual-architecture template to a valid offline archive', () => {
    expect(deploymentContinuationRequirement(
      '/instances?create=1&template=version-dual&image=image-arm',
      templates,
      [],
      [armImage],
    )).toMatchObject({
      status: 'resolved',
      architectures: ['arm64'],
      imageName: 'ARM offline archive',
    })
  })

  it('ignores an unavailable archive just as the create wizard falls back to the public image', () => {
    expect(deploymentContinuationRequirement(
      '/instances?create=1&template=version-dual&image=missing',
      templates,
      [],
      [],
    )).toMatchObject({ status: 'resolved', architectures: ['amd64', 'arm64'] })
  })

  it('keeps generic creation unconstrained and rejects stale context', () => {
    const generic = deploymentContinuationRequirement('/instances?create=1', templates, [], [])
    expect(generic).toEqual({ status: 'unconstrained', architectures: [] })
    expect(hostMeetsDeploymentRequirement({ architecture: '' }, generic)).toBe(true)
    expect(deploymentContinuationRequirement('/instances?create=1&template=missing', templates, [], [])).toEqual({
      status: 'unresolved',
      architectures: [],
    })
    expect(deploymentContinuationRequirement('/instances?create=1&copy=missing', templates, [], [])).toEqual({
      status: 'unresolved',
      architectures: [],
    })
  })
})
