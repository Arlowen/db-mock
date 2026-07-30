import type { DatabaseTemplate, TemplateVersion } from './types'

export type TemplateAuthentication = 'password' | 'username' | 'none'

export function templateAuthentication(template: Pick<DatabaseTemplate, 'slug'>, version: Pick<TemplateVersion, 'manifest'>): TemplateAuthentication {
  const declared = version.manifest.authentication
  if (declared === 'password' || declared === 'username' || declared === 'none') return declared
  if (template.slug === 'cassandra') return 'none'
  if (['tidb', 'starrocks', 'doris'].includes(template.slug)) return 'username'
  return 'password'
}
