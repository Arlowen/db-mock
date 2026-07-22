import { describe, expect, it } from 'vitest'
import type { Host, Instance } from './types'
import { hostCanAccept, hostCanReconfigure, remainingAfterDeployment, reservationForHost, schedulableCapacity } from './host-capacity'

const host = {
  id: 'host-1', cpuCount: 10, memoryBytes: 1000, diskFreeBytes: 1000, portStart: 20000, portEnd: 20010,
} as Host

describe('host capacity', () => {
  it('sums active instance reservations for one host', () => {
    const instances = [
      { hostId: 'host-1', cpu: 2, memoryBytes: 100, reservedDiskBytes: 200, hostPort: 20001 },
      { hostId: 'host-2', cpu: 8, memoryBytes: 800, reservedDiskBytes: 800, hostPort: 20002 },
      { hostId: 'host-1', cpu: 1, memoryBytes: 50, reservedDiskBytes: 100, hostPort: 20003 },
    ] as Instance[]

    expect(reservationForHost(instances, 'host-1')).toEqual({ cpu: 3, memory: 150, disk: 300, ports: [20001, 20003] })
  })

  it('uses the same deployment headroom as the backend scheduler', () => {
    const reservation = { cpu: 4, memory: 300, disk: 300, ports: [] }
    expect(schedulableCapacity(host, reservation)).toEqual({ cpu: 5, memory: 500, disk: 500 })
    expect(hostCanAccept(host, reservation, { cpu: 5, memory: 500, disk: 500 })).toBe(true)
    expect(hostCanAccept(host, reservation, { cpu: 5.01, memory: 500, disk: 500 })).toBe(false)
  })

  it('rejects occupied and out-of-pool requested ports', () => {
    const reservation = { cpu: 0, memory: 0, disk: 0, ports: [20001] }
    const request = { cpu: 1, memory: 100, disk: 100 }
    expect(hostCanAccept(host, reservation, { ...request, port: 20002 })).toBe(true)
    expect(hostCanAccept(host, reservation, { ...request, port: 20001 })).toBe(false)
    expect(hostCanAccept(host, reservation, { ...request, port: 19999 })).toBe(false)
  })

  it('previews remaining schedulable capacity after deployment', () => {
    expect(remainingAfterDeployment(host, { cpu: 4, memory: 300, disk: 300, ports: [] }, { cpu: 2, memory: 100, disk: 200 }))
      .toEqual({ cpu: 3, memory: 400, disk: 300 })
  })

  it('allows existing reservations and reductions on an overcommitted host but rejects growth', () => {
    const reservation = { cpu: 6, memory: 600, disk: 600, ports: [] }
    const current = { cpu: 4, memory: 400, disk: 400 }
    expect(hostCanReconfigure(host, reservation, current, current)).toBe(true)
    expect(hostCanReconfigure(host, reservation, current, { cpu: 2, memory: 300, disk: 300 })).toBe(true)
    expect(hostCanReconfigure(host, reservation, current, { cpu: 2, memory: 500, disk: 300 })).toBe(false)
  })
})
