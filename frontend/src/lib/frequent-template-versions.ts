import type { DatabaseTemplate, TemplateVersion } from './types'

export interface FrequentTemplateVersion {
  template: DatabaseTemplate
  version: TemplateVersion
}

function timestamp(value?: string): number {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

export function frequentTemplateVersions(
  templates: DatabaseTemplate[],
  limit = 3,
): FrequentTemplateVersion[] {
  if (limit <= 0) return []
  return templates
    .flatMap((template) => template.versions.map((version) => ({ template, version })))
    .filter(({ version }) => version.selectable !== false && (version.deploymentCount || 0) > 0)
    .sort((left, right) => {
      const countDifference = (right.version.deploymentCount || 0) - (left.version.deploymentCount || 0)
      if (countDifference) return countDifference
      const recencyDifference = timestamp(right.version.lastDeployedAt) - timestamp(left.version.lastDeployedAt)
      if (recencyDifference) return recencyDifference
      const nameDifference = left.template.name.localeCompare(right.template.name)
      return nameDifference || left.version.version.localeCompare(right.version.version)
    })
    .slice(0, limit)
}
