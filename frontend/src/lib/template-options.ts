import type { ResourceProfile, TemplateParameter, TemplateParameterValue, TemplateVersion } from './types'

const parameterTypes = new Set(['text', 'number', 'boolean', 'select'])

export function templateParameters(version?: Pick<TemplateVersion, 'manifest'>): TemplateParameter[] {
  const values = version?.manifest?.parameters
  if (!Array.isArray(values)) return []
  return values.filter((parameter): parameter is TemplateParameter => {
    if (!parameter || typeof parameter !== 'object') return false
    if (typeof parameter.key !== 'string' || typeof parameter.environment !== 'string' || typeof parameter.label !== 'string') return false
    if (!parameterTypes.has(parameter.type)) return false
    return parameter.type !== 'select' || Array.isArray(parameter.options)
  })
}

export function templateResourceProfiles(version?: Pick<TemplateVersion, 'manifest'>): ResourceProfile[] {
  const values = version?.manifest?.resourceProfiles
  if (!Array.isArray(values)) return []
  return values.filter((profile): profile is ResourceProfile => !!profile && typeof profile === 'object' &&
    typeof profile.name === 'string' && Number.isFinite(profile.cpu) && Number.isFinite(profile.memoryBytes) && Number.isFinite(profile.diskBytes) &&
    profile.cpu > 0 && profile.memoryBytes > 0 && profile.diskBytes > 0)
}

export function templateParameterDefaults(parameters: TemplateParameter[]): Record<string, TemplateParameterValue> {
  return Object.fromEntries(parameters.filter((parameter) => parameter.default !== undefined).map((parameter) => [parameter.key, parameter.default!]))
}

export function localizedTemplateText(english: string | undefined, chinese: string | undefined, language: string) {
  return language.startsWith('zh') && chinese ? chinese : english || chinese || ''
}

export function displayTemplateParameterValue(parameter: TemplateParameter, value: TemplateParameterValue | undefined, language: string, enabled: string, disabled: string) {
  if (value === undefined) return '—'
  if (parameter.type === 'boolean') return value ? enabled : disabled
  if (parameter.type === 'select') {
    const option = parameter.options?.find((item) => item.value === value)
    if (option) return localizedTemplateText(option.label, option.labelZh, language)
  }
  return String(value)
}
