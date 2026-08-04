import { describe, expect, it } from 'vitest'
import { mvpHostPayload } from './mvp-host'

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
  it('submits only the host connection and deployment fields shown in the MVP form', () => {
    const payload = mvpHostPayload(values)
    expect(payload).toEqual(values)
    for (const retired of ['projectId', 'maintenance', 'autoRestartDefault', 'labels']) {
      expect(payload).not.toHaveProperty(retired)
    }
  })
})
