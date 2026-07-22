import type { Host, Instance } from './types'

export interface HostReservation {
  cpu: number
  memory: number
  disk: number
  ports: number[]
}

export interface DeploymentRequest {
  cpu: number
  memory: number
  disk: number
  port?: number
}

export interface HostCapacity {
  cpu: number
  memory: number
  disk: number
}

export function reservationForHost(instances: Instance[], hostID: string): HostReservation {
  return instances.filter((instance) => instance.hostId === hostID).reduce((total, instance) => ({
    cpu: total.cpu + instance.cpu,
    memory: total.memory + instance.memoryBytes,
    disk: total.disk + instance.reservedDiskBytes,
    ports: instance.hostPort ? [...total.ports, instance.hostPort] : total.ports,
  }), { cpu: 0, memory: 0, disk: 0, ports: [] } as HostReservation)
}

export function schedulableCapacity(host: Host, reservation: HostReservation): HostCapacity {
  return {
    cpu: Math.max(0, host.cpuCount * .9 - reservation.cpu),
    memory: Math.max(0, host.memoryBytes * .8 - reservation.memory),
    disk: Math.max(0, host.diskFreeBytes * .8 - reservation.disk),
  }
}

export function remainingAfterDeployment(host: Host, reservation: HostReservation, request: DeploymentRequest): HostCapacity {
  const available = schedulableCapacity(host, reservation)
  return {
    cpu: Math.max(0, available.cpu - request.cpu),
    memory: Math.max(0, available.memory - request.memory),
    disk: Math.max(0, available.disk - request.disk),
  }
}

export function hostCanAccept(host: Host, reservation: HostReservation, request: DeploymentRequest): boolean {
  const available = schedulableCapacity(host, reservation)
  if (request.cpu > available.cpu + Number.EPSILON || request.memory > available.memory || request.disk > available.disk) return false
  if (!request.port) return true
  return request.port >= host.portStart && request.port <= host.portEnd && !reservation.ports.includes(request.port)
}

export function hostCanReconfigure(host: Host, reservationWithoutInstance: HostReservation,
  current: DeploymentRequest, request: DeploymentRequest): boolean {
  const available = schedulableCapacity(host, reservationWithoutInstance)
  return (request.cpu <= available.cpu + Number.EPSILON || request.cpu <= current.cpu)
    && (request.memory <= available.memory || request.memory <= current.memory)
    && (request.disk <= available.disk || request.disk <= current.disk)
}

export function hostHeadroomScore(host: Host, reservation: HostReservation): number {
  return (host.cpuCount - reservation.cpu) / Math.max(host.cpuCount, 1)
    + (host.memoryBytes - reservation.memory) / Math.max(host.memoryBytes, 1)
}
