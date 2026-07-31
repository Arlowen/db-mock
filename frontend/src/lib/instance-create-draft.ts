export type InstanceTemplateDraftAction = 'wait' | 'copy' | 'initialize' | 'preserve'

export function instanceTemplateDraftAction(input: {
  initializedTemplateVersionId?: string
  selectedTemplateVersionId?: string
  copySourceTemplateVersionId?: string
  copyPrefillApplied: boolean
}): InstanceTemplateDraftAction {
  if (!input.selectedTemplateVersionId) return 'wait'
  if (
    input.copySourceTemplateVersionId === input.selectedTemplateVersionId
    && !input.copyPrefillApplied
  ) return 'copy'
  if (input.initializedTemplateVersionId === input.selectedTemplateVersionId) return 'preserve'
  return 'initialize'
}
