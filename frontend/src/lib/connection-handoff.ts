export interface ConnectionHandoffDetails {
  instanceName: string
  templateName: string
  templateVersion: string
  environment: string
  status: string
  dataVersion?: string
  backupCreatedAt?: string
  restoreVerifiedAt?: string
  address: string
  port: number
  username: string
  password: string
  database: string
  uri: string
  jdbc?: string
}

export interface ConnectionHandoffLabels {
  title: string
  instance: string
  template: string
  environment: string
  status: string
  dataVersion: string
  backupCreatedAt: string
  restoreVerifiedAt: string
  address: string
  port: string
  username: string
  password: string
  database: string
  uri: string
  jdbc: string
}

export function connectionHandoffSummary(details: ConnectionHandoffDetails, labels: ConnectionHandoffLabels) {
  const lines = [
    labels.title,
    `${labels.instance}: ${details.instanceName}`,
    `${labels.template}: ${details.templateName} ${details.templateVersion}`,
    `${labels.environment}: ${details.environment}`,
    `${labels.status}: ${details.status}`,
  ]
  if (details.dataVersion) lines.push(`${labels.dataVersion}: ${details.dataVersion}`)
  if (details.backupCreatedAt) lines.push(`${labels.backupCreatedAt}: ${details.backupCreatedAt}`)
  if (details.restoreVerifiedAt) lines.push(`${labels.restoreVerifiedAt}: ${details.restoreVerifiedAt}`)
  lines.push(
    `${labels.address}: ${details.address}`,
    `${labels.port}: ${details.port}`,
    `${labels.username}: ${details.username}`,
    `${labels.password}: ${details.password}`,
    `${labels.database}: ${details.database}`,
    `${labels.uri}: ${details.uri}`,
  )
  if (details.jdbc) lines.push(`${labels.jdbc}: ${details.jdbc}`)
  return lines.join('\n')
}
