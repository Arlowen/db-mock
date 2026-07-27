import { describe, expect, it } from 'vitest'
import type { Instance } from './types'
import { deploymentCopyDraft } from './instance-copy'

const source: Instance = {
  id: 'instance-1',
  name: 'Orders integration',
  projectId: 'project-1',
  hostId: 'host-1',
  templateVersionId: 'postgres-17',
  environment: 'testing',
  purpose: 'Verify the orders release candidate',
  owner: 'Orders QA',
  expiresAt: '2026-07-30T16:00:00Z',
  labels: { purpose: 'integration', team: 'orders' },
  status: 'running',
  desiredState: 'running',
  autoRestart: false,
  restartFailures: 0,
  cpu: 2,
  memoryBytes: 4 * 1024 ** 3,
  reservedDiskBytes: 20 * 1024 ** 3,
  hostPort: 25432,
  containerPort: 5432,
  bindAddress: '127.0.0.1',
  databaseUsername: 'orders_app',
  databaseName: 'orders_test',
  configuration: {
    extraEnvironment: { TZ: 'Asia/Shanghai' },
    templateParameters: { audit_enabled: true, max_connections: 200 },
    registryId: 'registry-1',
  },
  templateSlug: 'postgresql',
  templateName: 'PostgreSQL',
  templateVersion: '17',
  hostName: 'Test host',
  connectionAddress: '10.0.0.8',
  createdAt: '2026-07-27T00:00:00Z',
}

describe('deploymentCopyDraft', () => {
  it('reuses non-sensitive deployment configuration', () => {
    expect(deploymentCopyDraft(source, ['project-1'])).toMatchObject({
      projectId: 'project-1',
      environment: 'testing',
      purpose: 'Verify the orders release candidate',
      templateVersionId: 'postgres-17',
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 20,
      bindAddress: '127.0.0.1',
      username: 'orders_app',
      databaseName: 'orders_test',
      autoRestart: false,
      imageSource: 'registry',
      registryId: 'registry-1',
      labels: 'purpose=integration, team=orders',
      extraEnvironment: '{\n  "TZ": "Asia/Shanghai"\n}',
      templateParameters: { audit_enabled: true, max_connections: 200 },
    })
  })

  it('never reuses identity, credential, host, or port fields', () => {
    const draft = deploymentCopyDraft(source, ['project-1'])
    expect(draft.name).toBe('')
    expect(draft.password).toBeUndefined()
    expect(draft.hostId).toBeUndefined()
    expect(draft.hostPort).toBeUndefined()
    expect(draft).not.toHaveProperty('owner')
    expect(draft).not.toHaveProperty('expiresAt')
  })

  it('drops a deleted project and preserves an offline image choice', () => {
    const draft = deploymentCopyDraft({
      ...source,
      configuration: { imageArtifactId: 'image-1' },
    }, ['another-project'])
    expect(draft.projectId).toBeUndefined()
    expect(draft.imageSource).toBe('offline')
    expect(draft.imageArtifactId).toBe('image-1')
    expect(draft.registryId).toBeUndefined()
  })
})
