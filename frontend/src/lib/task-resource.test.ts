import { describe, expect, it } from 'vitest'
import { taskResourceReference } from './task-resource'
import type { Task } from './types'

const task = {
  id: 'task-id',
  resourceType: 'instance',
  resourceId: 'instance-id',
} as Task

describe('task resource reference', () => {
  it('links instance and host resources directly', () => {
    expect(taskResourceReference(task)).toEqual({
      lookupType: 'instance',
      lookupID: 'instance-id',
      fallbackID: 'instance-id',
      path: '/instances/instance-id',
    })
    expect(taskResourceReference({ ...task, resourceType: 'host', resourceId: 'host id' })).toEqual({
      lookupType: 'host',
      lookupID: 'host id',
      fallbackID: 'host id',
      path: '/hosts?host=host%20id',
    })
  })

  it('uses the related instance as the backup task destination', () => {
    expect(taskResourceReference({
      ...task,
      resourceType: 'backup',
      resourceId: 'backup-id',
      payload: { instanceId: 'instance id', backupId: 'backup-id' },
    })).toEqual({
      lookupType: 'instance',
      lookupID: 'instance id',
      fallbackID: 'backup-id',
      path: '/instances/instance%20id',
    })
  })

  it('keeps legacy backup tasks readable without inventing a destination', () => {
    expect(taskResourceReference({ ...task, resourceType: 'backup', resourceId: 'backup-id', payload: {} })).toEqual({
      fallbackID: 'backup-id',
    })
    expect(taskResourceReference({ ...task, resourceType: 'image', resourceId: undefined })).toEqual({
      fallbackID: undefined,
    })
  })
})
