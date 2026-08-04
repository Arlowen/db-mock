import { describe, expect, it } from 'vitest'
import { mvpDatabaseTemplates, mvpInstanceCreatePayload } from './mvp-instance-create'
import type { DatabaseTemplate } from './types'

function template(id: string, tier: DatabaseTemplate['tier'], builtin = true): DatabaseTemplate {
  return {
    id,
    slug: id,
    name: id,
    nameZh: id,
    description: '',
    category: 'relational',
    tier,
    builtin,
    icon: id,
    riskReport: [],
    versions: [],
  }
}

describe('MVP database creation', () => {
  it('offers only built-in standard database templates', () => {
    expect(mvpDatabaseTemplates([
      template('postgresql', 'standard'),
      template('tidb', 'experimental'),
      template('team-custom', 'custom', false),
    ]).map((item) => item.id)).toEqual(['postgresql'])
  })

  it('submits only fields required by the deployment API and relies on backend defaults', () => {
    const payload = mvpInstanceCreatePayload({
      name: '  orders-db  ',
      templateVersionId: 'postgresql-17',
      hostId: undefined,
      cpu: 1,
      memoryGiB: 1.5,
      diskGiB: 10,
      templateParameters: { locale: 'zh_CN.UTF-8' },
    })

    expect(payload).toEqual({
      name: 'orders-db',
      templateVersionId: 'postgresql-17',
      hostId: null,
      cpu: 1,
      memoryBytes: 1.5 * 1024 ** 3,
      diskBytes: 10 * 1024 ** 3,
      templateParameters: { locale: 'zh_CN.UTF-8' },
    })
    expect(payload).not.toHaveProperty('projectId')
    expect(payload).not.toHaveProperty('environment')
    expect(payload).not.toHaveProperty('expiresAt')
    expect(payload).not.toHaveProperty('imageArtifactId')
    expect(payload).not.toHaveProperty('registryId')
  })
})
