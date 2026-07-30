import { describe, expect, it } from 'vitest'
import { frequentTemplateVersions } from './frequent-template-versions'
import type { DatabaseTemplate, TemplateVersion } from './types'

function version(
  id: string,
  deploymentCount: number,
  lastDeployedAt: string,
  selectable = true,
): TemplateVersion {
  return {
    id,
    templateId: `template-${id}`,
    version: id,
    imageReference: `example:${id}`,
    architectures: ['amd64'],
    minCpu: 1,
    minMemoryBytes: 1024,
    minDiskBytes: 1024,
    defaultPort: 5432,
    manifest: {},
    riskReport: [],
    selectable,
    deploymentCount,
    lastDeployedAt,
    createdAt: '2026-01-01T00:00:00Z',
  }
}

function template(name: string, versions: TemplateVersion[]): DatabaseTemplate {
  return {
    id: `template-${name}`,
    slug: name.toLowerCase(),
    name,
    nameZh: name,
    description: '',
    category: 'sql',
    tier: 'standard',
    builtin: true,
    icon: '',
    riskReport: [],
    versions,
  }
}

describe('frequentTemplateVersions', () => {
  it('ranks selectable versions by historical deployments and then recent use', () => {
    const items = [
      template('Redis', [version('8', 2, '2026-07-20T08:00:00Z')]),
      template('PostgreSQL', [version('17', 5, '2026-07-18T08:00:00Z')]),
      template('MySQL', [version('8.4', 2, '2026-07-25T08:00:00Z')]),
    ]

    expect(frequentTemplateVersions(items).map(({ template: item }) => item.name))
      .toEqual(['PostgreSQL', 'MySQL', 'Redis'])
  })

  it('omits unused and non-selectable versions', () => {
    const items = [
      template('PostgreSQL', [version('17', 4, '2026-07-25T08:00:00Z', false)]),
      template('Redis', [version('8', 0, '')]),
      template('MySQL', [version('8.4', 1, '2026-07-25T08:00:00Z')]),
    ]

    expect(frequentTemplateVersions(items).map(({ template: item }) => item.name)).toEqual(['MySQL'])
  })

  it('honors the requested limit and returns no suggestions without history', () => {
    const items = [
      template('PostgreSQL', [version('17', 3, '2026-07-25T08:00:00Z')]),
      template('Redis', [version('8', 2, '2026-07-24T08:00:00Z')]),
    ]

    expect(frequentTemplateVersions(items, 1)).toHaveLength(1)
    expect(frequentTemplateVersions(items, 0)).toEqual([])
    expect(frequentTemplateVersions([template('MySQL', [version('8.4', 0, '')])])).toEqual([])
  })
})
