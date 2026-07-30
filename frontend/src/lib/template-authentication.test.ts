import { describe, expect, it } from 'vitest'
import { templateAuthentication, type TemplateAuthentication } from './template-authentication'

const version = (authentication?: TemplateAuthentication) => ({ manifest: { authentication } })

describe('templateAuthentication', () => {
  it.each(['password', 'username', 'none'] as const)('uses the explicit %s mode', (authentication) => {
    expect(templateAuthentication({ slug: 'custom' }, version(authentication))).toBe(authentication)
  })

  it('defaults custom and password-enabled built-ins to password authentication', () => {
    expect(templateAuthentication({ slug: 'postgresql' }, version())).toBe('password')
    expect(templateAuthentication({ slug: 'internal-database' }, version())).toBe('password')
  })

  it('keeps immutable legacy built-in versions accurate', () => {
    expect(templateAuthentication({ slug: 'cassandra' }, version())).toBe('none')
    expect(templateAuthentication({ slug: 'tidb' }, version())).toBe('username')
    expect(templateAuthentication({ slug: 'starrocks' }, version())).toBe('username')
    expect(templateAuthentication({ slug: 'doris' }, version())).toBe('username')
  })
})
