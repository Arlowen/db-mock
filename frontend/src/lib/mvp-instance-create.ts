import type { DatabaseTemplate, TemplateParameterValue } from './types'

export interface MvpInstanceCreateValues {
  name: string
  templateVersionId: string
  hostId?: string
  cpu: number
  memoryGiB: number
  diskGiB: number
  templateParameters?: Record<string, TemplateParameterValue>
}

export function mvpDatabaseTemplates(templates: DatabaseTemplate[]) {
  return templates.filter((template) => template.builtin && template.tier === 'standard')
}

export function mvpInstanceCreatePayload(values: MvpInstanceCreateValues) {
  return {
    name: values.name.trim(),
    templateVersionId: values.templateVersionId,
    hostId: values.hostId || null,
    cpu: values.cpu,
    memoryBytes: Math.round(values.memoryGiB * 1024 ** 3),
    diskBytes: Math.round(values.diskGiB * 1024 ** 3),
    templateParameters: values.templateParameters || {},
  }
}
