import type { Task } from './types'

export interface InstanceDeleteOutcome {
  instanceId: string
  instanceName: string
  hostId: string
  hostName: string
  releasedHostPort: number
  releasedBindAddress: string
  composeProjectRemoved: boolean
  managedDirectoryRemoved: boolean
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function instanceDeleteOutcome(task?: Task): InstanceDeleteOutcome | undefined {
  if (!task || task.status !== 'succeeded' || !['instance.delete', 'instance_delete'].includes(task.kind)) return undefined
  const result = task.result
  if (!result || result.status !== 'deleted') return undefined
  const instanceId = stringValue(result.instanceId)
  const instanceName = stringValue(result.instanceName)
  const hostId = stringValue(result.hostId)
  const hostName = stringValue(result.hostName)
  const releasedBindAddress = stringValue(result.releasedBindAddress)
  const releasedHostPort = result.releasedHostPort
  if (!instanceId || !instanceName || !hostId || !hostName || !releasedBindAddress ||
    typeof releasedHostPort !== 'number' || !Number.isInteger(releasedHostPort) ||
    releasedHostPort < 1 || releasedHostPort > 65535 ||
    result.composeProjectRemoved !== true || result.managedDirectoryRemoved !== true) return undefined
  return {
    instanceId,
    instanceName,
    hostId,
    hostName,
    releasedHostPort,
    releasedBindAddress,
    composeProjectRemoved: true,
    managedDirectoryRemoved: true,
  }
}
