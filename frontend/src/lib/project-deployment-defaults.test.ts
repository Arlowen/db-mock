import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { hasProjectDeploymentDefaults, hasProjectDeploymentProfile, hasProjectLifecycleDefaults, labelText, parseLabelText, projectDeploymentProfileValues, projectDeploymentValues } from './project-deployment-defaults'
import type { Project } from './types'

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Orders',
  description: '',
  color: '#2563eb',
  defaultLabels: {},
  hostCount: 0,
  instanceCount: 0,
  createdAt: '2026-07-27T00:00:00Z',
  updatedAt: '2026-07-27T00:00:00Z',
  ...overrides,
})

describe('project deployment defaults', () => {
  it('uses the platform lifecycle defaults when a project has no overrides', () => {
    const values = projectDeploymentValues(project(), dayjs('2026-07-27T08:00:00Z'))
    expect(values.environment).toBe('development')
    expect(values.labels).toBe('')
    expect(values.expiresAt?.diff(dayjs('2026-07-27T08:00:00Z'), 'day')).toBe(7)
    expect(hasProjectDeploymentDefaults(project())).toBe(false)
    expect(hasProjectLifecycleDefaults(project())).toBe(false)
    expect(hasProjectDeploymentProfile(project())).toBe(false)
  })

  it('applies environment, lifetime and stable labels from the project', () => {
    const item = project({ defaultEnvironment: 'testing', defaultExpiryDays: 14, defaultLabels: { team: 'orders', managed: 'qa' } })
    const values = projectDeploymentValues(item, dayjs('2026-07-27T08:00:00Z'))
    expect(values.environment).toBe('testing')
    expect(values.expiresAt?.diff(dayjs('2026-07-27T08:00:00Z'), 'day')).toBe(14)
    expect(values.labels).toBe('managed=qa, team=orders')
    expect(hasProjectDeploymentDefaults(item)).toBe(true)
    expect(hasProjectLifecycleDefaults(item)).toBe(true)
  })

  it('supports explicit indefinite retention and validates label input', () => {
    expect(projectDeploymentValues(project({ defaultExpiryDays: 0 })).expiresAt).toBeUndefined()
    expect(parseLabelText('team=orders, managed')).toEqual({ team: 'orders', managed: 'true' })
    expect(parseLabelText('=orders')).toBeUndefined()
    expect(labelText({ team: 'orders', managed: 'true' })).toBe('managed=true, team=orders')
  })

  it('converts a complete project deployment profile into create-form resources', () => {
    const item = project({
      defaultTemplateVersionId: 'postgres-17',
      defaultCpu: 2,
      defaultMemoryBytes: 4 * 1024 ** 3,
      defaultDiskBytes: 20 * 1024 ** 3,
    })
    expect(projectDeploymentProfileValues(item)).toEqual({
      templateVersionId: 'postgres-17',
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 20,
    })
    expect(hasProjectDeploymentDefaults(item)).toBe(true)
    expect(hasProjectDeploymentProfile(item)).toBe(true)
    expect(projectDeploymentProfileValues(project({ defaultTemplateVersionId: 'postgres-17' }))).toBeUndefined()
  })
})
