import { describe, expect, it } from 'vitest'
import { deploymentReturnPathForHost, safeCreateReturnPath } from './deployment-continuation'

describe('deployment continuation', () => {
  it('accepts only the database creation route', () => {
    expect(safeCreateReturnPath('/instances?create=1&template=version-1')).toBe('/instances?create=1&template=version-1')
    expect(safeCreateReturnPath('/instances?create=0')).toBe('')
    expect(safeCreateReturnPath('/instances?create=1evil')).toBe('')
    expect(safeCreateReturnPath('/tasks?create=1')).toBe('')
    expect(safeCreateReturnPath('//example.test/instances?create=1')).toBe('')
    expect(safeCreateReturnPath('https://example.test/instances?create=1')).toBe('')
  })

  it('adds the connected host without dropping creation context', () => {
    expect(deploymentReturnPathForHost(
      '/instances?create=1&template=version-1&project=project-1&image=image-1',
      ' host-1 ',
    )).toBe('/instances?create=1&template=version-1&project=project-1&image=image-1&host=host-1')
  })

  it('keeps a safe continuation unchanged when no host is selected', () => {
    expect(deploymentReturnPathForHost('/instances?create=1&copy=instance-1', '')).toBe('/instances?create=1&copy=instance-1')
    expect(deploymentReturnPathForHost('/catalog', 'host-1')).toBe('')
  })
})
