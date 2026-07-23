import { describe, expect, it } from 'vitest'
import { dockerManagementReady, hostConnectionReady, hostPortPoolInvalid } from './host-verification'

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

describe('Docker management verification', () => {
  it('requires a successful sudo probe when Docker management is newly enabled', () => {
    expect(dockerManagementReady(true, undefined, false, true)).toBe(false)
    expect(dockerManagementReady(true, false, false, false)).toBe(false)
    expect(dockerManagementReady(true, true, false, false)).toBe(true)
  })

  it('keeps an existing verified policy until connection details change', () => {
    expect(dockerManagementReady(true, undefined, true, false)).toBe(true)
    expect(dockerManagementReady(true, undefined, true, true)).toBe(false)
    expect(dockerManagementReady(false, undefined, true, true)).toBe(true)
  })
})
