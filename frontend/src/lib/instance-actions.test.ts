import { describe, expect, it } from 'vitest'
import { instanceQuickAction } from './instance-actions'

describe('instanceQuickAction', () => {
  it('offers only safe list-level lifecycle actions', () => {
    expect(instanceQuickAction('running')).toBe('stop')
    expect(instanceQuickAction('degraded')).toBe('stop')
    expect(instanceQuickAction('stopped')).toBe('start')
    expect(instanceQuickAction('provisioning')).toBeNull()
    expect(instanceQuickAction('failed')).toBeNull()
  })
})
