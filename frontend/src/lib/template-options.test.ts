import { describe, expect, it } from 'vitest'
import { displayTemplateParameterValue, localizedTemplateText, templateParameterDefaults, templateParameters, templateResourceProfiles } from './template-options'
import type { TemplateVersion } from './types'

const version = {
  manifest: {
    parameters: [
      { key: 'timezone', type: 'select', environment: 'TZ', label: 'Time zone', labelZh: '时区', required: true, default: 'UTC', options: [{ value: 'UTC', label: 'UTC' }, { value: 'Asia/Shanghai', label: 'Shanghai', labelZh: '上海' }] },
      { key: 'workers', type: 'number', environment: 'WORKERS', label: 'Workers', required: false, default: 4 },
      { key: 'invalid', type: 'secret', environment: 'SECRET', label: 'Secret', required: false },
    ],
    resourceProfiles: [
      { name: 'small', cpu: 1, memoryBytes: 1024, diskBytes: 2048 },
      { name: 'broken', cpu: 0, memoryBytes: 0, diskBytes: 0 },
    ],
  },
} as unknown as TemplateVersion

describe('template options', () => {
  it('normalizes parameter forms and defaults from the immutable manifest', () => {
    const parameters = templateParameters(version)
    expect(parameters.map((item) => item.key)).toEqual(['timezone', 'workers'])
    expect(templateParameterDefaults(parameters)).toEqual({ timezone: 'UTC', workers: 4 })
  })

  it('normalizes resource profiles and localizes labels', () => {
    expect(templateResourceProfiles(version).map((item) => item.name)).toEqual(['small'])
    expect(localizedTemplateText('Time zone', '时区', 'zh-CN')).toBe('时区')
    expect(localizedTemplateText('Time zone', '时区', 'en-US')).toBe('Time zone')
  })

  it('formats select and boolean values for the review step', () => {
    const parameters = templateParameters(version)
    expect(displayTemplateParameterValue(parameters[0], 'Asia/Shanghai', 'zh-CN', '启用', '禁用')).toBe('上海')
    expect(displayTemplateParameterValue({ key: 'enabled', type: 'boolean', environment: 'ENABLED', label: 'Enabled', required: false }, false, 'en-US', 'Enabled', 'Disabled')).toBe('Disabled')
  })
})
