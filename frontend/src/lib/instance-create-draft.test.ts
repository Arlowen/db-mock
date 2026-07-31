import { describe, expect, it } from 'vitest'
import { instanceTemplateDraftAction } from './instance-create-draft'

describe('instance create draft initialization', () => {
  it('initializes a newly selected template and a genuinely different template', () => {
    expect(instanceTemplateDraftAction({
      selectedTemplateVersionId: 'postgres-17',
      copyPrefillApplied: false,
    })).toBe('initialize')
    expect(instanceTemplateDraftAction({
      initializedTemplateVersionId: 'postgres-17',
      selectedTemplateVersionId: 'mysql-8',
      copyPrefillApplied: false,
    })).toBe('initialize')
  })

  it('preserves deliberate form values when supporting data refreshes the same template', () => {
    expect(instanceTemplateDraftAction({
      initializedTemplateVersionId: 'postgres-17',
      selectedTemplateVersionId: 'postgres-17',
      copyPrefillApplied: false,
    })).toBe('preserve')
  })

  it('applies a copy draft once, then preserves it across context refreshes', () => {
    expect(instanceTemplateDraftAction({
      selectedTemplateVersionId: 'postgres-17',
      copySourceTemplateVersionId: 'postgres-17',
      copyPrefillApplied: false,
    })).toBe('copy')
    expect(instanceTemplateDraftAction({
      initializedTemplateVersionId: 'postgres-17',
      selectedTemplateVersionId: 'postgres-17',
      copySourceTemplateVersionId: 'postgres-17',
      copyPrefillApplied: true,
    })).toBe('preserve')
  })

  it('waits without changing initialization state while no selectable template is available', () => {
    expect(instanceTemplateDraftAction({
      initializedTemplateVersionId: 'postgres-17',
      copyPrefillApplied: true,
    })).toBe('wait')
  })
})
