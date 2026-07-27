import { describe, expect, it } from 'vitest'
import type { Instance } from './types'
import { canBatchInstanceAction, instanceBatchActionPlan, instanceQuickAction } from './instance-actions'

describe('instanceQuickAction', () => {
  it('offers only safe list-level lifecycle actions', () => {
    expect(instanceQuickAction('running')).toBe('stop')
    expect(instanceQuickAction('degraded')).toBe('stop')
    expect(instanceQuickAction('stopped')).toBe('start')
    expect(instanceQuickAction('provisioning')).toBeNull()
    expect(instanceQuickAction('failed')).toBeNull()
  })
})

describe('instanceBatchActionPlan', () => {
  const instances = [
    { id: 'running', name: 'Orders', status: 'running' },
    { id: 'degraded', name: 'Billing', status: 'degraded' },
    { id: 'stopped', name: 'Cache', status: 'stopped' },
    { id: 'failed', name: 'Settlement', status: 'failed' },
  ] as Instance[]

  it('queues stop only for stable running states and explains the rest as skipped', () => {
    const plan = instanceBatchActionPlan(instances, 'stop')
    expect(plan.eligible.map((item) => item.id)).toEqual(['running', 'degraded'])
    expect(plan.skipped.map((item) => item.id)).toEqual(['stopped', 'failed'])
  })

  it('does not treat failed recovery as a bulk start', () => {
    const plan = instanceBatchActionPlan(instances, 'start')
    expect(plan.eligible.map((item) => item.id)).toEqual(['stopped'])
    expect(canBatchInstanceAction('failed', 'start')).toBe(false)
  })
})
