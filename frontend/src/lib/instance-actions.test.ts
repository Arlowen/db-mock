import { describe, expect, it } from 'vitest'
import { instanceListActions } from './instance-actions'

describe('instanceListActions', () => {
  it('offers all state-valid list actions while keeping unstable states read-only', () => {
    expect(instanceListActions('running')).toEqual(['restart', 'stop'])
    expect(instanceListActions('degraded')).toEqual(['restart', 'stop'])
    expect(instanceListActions('stopped')).toEqual(['start'])
    expect(instanceListActions('provisioning')).toEqual([])
    expect(instanceListActions('failed')).toEqual([])
  })
})
