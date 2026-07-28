import { describe, expect, it } from 'vitest'
import { restoreOutcome } from './restore-outcome'
import type { Instance, Task } from './types'

const task = {
  kind: 'instance.restore',
  status: 'failed',
} as Task

const instance = {
  status: 'running',
} as Instance

describe('restore outcome', () => {
  it('prefers the durable task result', () => {
    expect(restoreOutcome({
      ...task,
      result: { restoreOutcome: 'pre_restore_recovered', instanceStatus: 'stopped' },
    })).toEqual({ state: 'pre_restore_recovered', instanceStatus: 'stopped' })
    expect(restoreOutcome({
      ...task,
      result: { restoreOutcome: 'rollback_incomplete', instanceStatus: 'failed' },
    }, instance)).toEqual({ state: 'rollback_incomplete', instanceStatus: 'running' })
  })

  it('supports legacy tasks through the authoritative instance status message', () => {
    expect(restoreOutcome(task, {
      ...instance,
      statusMessage: 'Restore failed; the pre-restore database state was recovered',
    })).toEqual({ state: 'pre_restore_recovered', instanceStatus: 'running' })
    expect(restoreOutcome(task, {
      ...instance,
      status: 'failed',
      statusMessage: 'Restore failed and automatic rollback did not complete',
    })).toEqual({ state: 'rollback_incomplete', instanceStatus: 'failed' })
  })

  it('treats a canceled restore returned to a stable state as recovered', () => {
    expect(restoreOutcome({ ...task, status: 'canceled' }, instance)).toEqual({
      state: 'pre_restore_recovered',
      instanceStatus: 'running',
    })
  })

  it('does not invent an outcome without durable evidence', () => {
    expect(restoreOutcome(task, instance)).toBeUndefined()
    expect(restoreOutcome({ ...task, status: 'succeeded', result: { restoreOutcome: 'pre_restore_recovered' } }, instance)).toBeUndefined()
    expect(restoreOutcome({ ...task, kind: 'instance.backup' }, instance)).toBeUndefined()
  })
})
