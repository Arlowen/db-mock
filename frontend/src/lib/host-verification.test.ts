import { describe, expect, it } from 'vitest'
import { dockerManagementReady } from './host-verification'

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
