import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStoredValue, removeStoredValue, setStoredValue } from './storage'

describe('safe browser storage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses browser local storage when it is available', () => {
    localStorage.clear()
    setStoredValue('available', 'value')
    expect(localStorage.getItem('available')).toBe('value')
    expect(getStoredValue('available')).toBe('value')
    removeStoredValue('available')
    expect(getStoredValue('available')).toBeNull()
  })

  it('falls back to memory when local storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    setStoredValue('unavailable', 'value')
    expect(getStoredValue('unavailable')).toBe('value')
    removeStoredValue('unavailable')
    expect(getStoredValue('unavailable')).toBeNull()
  })

  it('falls back to memory when browser storage rejects access', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError') },
      setItem: () => { throw new DOMException('blocked', 'SecurityError') },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError') },
    }
    vi.stubGlobal('localStorage', unavailable)
    setStoredValue('blocked', 'value')
    expect(getStoredValue('blocked')).toBe('value')
    removeStoredValue('blocked')
    expect(getStoredValue('blocked')).toBeNull()
  })
})
