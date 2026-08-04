import { describe, expect, it } from 'vitest'
import { hostConnectionReady, hostPortPoolInvalid } from './host-verification'

const connection = {
  sshAddress: '192.0.2.10',
  sshPort: 22,
  sshUser: 'dbmock',
  authType: 'private_key',
  credential: 'private-key',
  dataRoot: '/opt/dbmock',
  portStart: 20000,
  portEnd: 40000,
}

describe('Host connection readiness', () => {
  it('enables testing only after the required connection details are complete', () => {
    expect(hostConnectionReady(undefined, true)).toBe(false)
    expect(hostConnectionReady({ ...connection, sshAddress: ' ' }, true)).toBe(false)
    expect(hostConnectionReady({ ...connection, credential: '' }, true)).toBe(false)
    expect(hostConnectionReady(connection, true)).toBe(true)
  })

  it('allows an existing stored credential when editing an unchanged host', () => {
    expect(hostConnectionReady({ ...connection, credential: '' }, false)).toBe(true)
  })

  it('rejects invalid SSH and port-pool ranges before testing', () => {
    expect(hostConnectionReady({ ...connection, sshPort: 0 }, true)).toBe(false)
    expect(hostConnectionReady({ ...connection, portStart: 40001 }, true)).toBe(false)
    expect(hostConnectionReady({ ...connection, portEnd: 65536 }, true)).toBe(false)
    expect(hostPortPoolInvalid({ ...connection, portStart: 40001 })).toBe(true)
  })
})
