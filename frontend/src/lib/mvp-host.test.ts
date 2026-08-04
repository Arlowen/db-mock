import { describe, expect, it } from 'vitest'
import { mvpHostPayload } from './mvp-host'
import type { Host } from './types'

const values = {
  name: 'Daily Docker Host',
  sshAddress: '10.0.0.8',
  sshPort: 22,
  sshUser: 'dbmock',
  authType: 'password',
  credential: 'secret',
  connectionAddress: 'db.test.internal',
  dataRoot: '/opt/dbmock',
  portStart: 20000,
  portEnd: 40000,
}

describe('mvpHostPayload', () => {
  it('uses simple policy defaults for a new host', () => {
    expect(mvpHostPayload(values)).toMatchObject({
      maintenance: false,
      autoRestartDefault: true,
      labels: {},
    })
  })

  it('preserves hidden compatibility fields when an existing host is edited', () => {
    const existing = {
      projectId: 'project-id',
      maintenance: true,
      autoRestartDefault: false,
      labels: { zone: 'lab' },
    } as unknown as Host

    expect(mvpHostPayload(values, existing)).toMatchObject({
      projectId: 'project-id',
      maintenance: true,
      autoRestartDefault: false,
      labels: { zone: 'lab' },
    })
  })
})
