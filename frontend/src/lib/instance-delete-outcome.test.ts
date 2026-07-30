import { describe, expect, it } from 'vitest'
import { instanceDeleteOutcome } from './instance-delete-outcome'
import type { Task } from './types'

const succeededDelete = {
  id: 'task-id',
  kind: 'instance.delete',
  status: 'succeeded',
  resourceType: 'instance',
  resourceId: 'instance-id',
  progress: 100,
  stage: 'completed',
  message: 'task_completed',
  result: {
    instanceId: 'instance-id',
    instanceName: 'orders-cleanup-pg17',
    hostId: 'host-id',
    hostName: 'QA Hangzhou 01',
    releasedHostPort: 20001,
    releasedBindAddress: '0.0.0.0',
    composeProjectRemoved: true,
    managedDirectoryRemoved: true,
    status: 'deleted',
  },
  cancelable: false,
  cancelAsked: false,
  attempts: 1,
  createdAt: '2026-07-30T12:00:00Z',
} satisfies Task

describe('instance delete outcome', () => {
  it('keeps the durable cleanup and port-release receipt', () => {
    expect(instanceDeleteOutcome(succeededDelete)).toEqual({
      instanceId: 'instance-id',
      instanceName: 'orders-cleanup-pg17',
      hostId: 'host-id',
      hostName: 'QA Hangzhou 01',
      releasedHostPort: 20001,
      releasedBindAddress: '0.0.0.0',
      composeProjectRemoved: true,
      managedDirectoryRemoved: true,
    })
  })

  it('accepts the legacy underscore task kind', () => {
    expect(instanceDeleteOutcome({ ...succeededDelete, kind: 'instance_delete' })).toBeDefined()
  })

  it('does not claim cleanup without every server-confirmed fact', () => {
    expect(instanceDeleteOutcome({ ...succeededDelete, status: 'failed' })).toBeUndefined()
    expect(instanceDeleteOutcome({ ...succeededDelete, result: { ...succeededDelete.result, managedDirectoryRemoved: false } })).toBeUndefined()
    expect(instanceDeleteOutcome({ ...succeededDelete, result: { ...succeededDelete.result, releasedHostPort: 70000 } })).toBeUndefined()
  })
})
