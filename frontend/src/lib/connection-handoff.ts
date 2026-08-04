export interface ConnectionHandoffDetails {
  instanceName: string
  templateName: string
  templateVersion: string
  status: string
  authentication: string
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
  status: string
  authentication: string
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
    `${labels.status}: ${details.status}`,
    `${labels.authentication}: ${details.authentication}`,
  ]
  if (details.dataVersion) lines.push(`${labels.dataVersion}: ${details.dataVersion}`)
  if (details.backupCreatedAt) lines.push(`${labels.backupCreatedAt}: ${details.backupCreatedAt}`)
  if (details.restoreVerifiedAt) lines.push(`${labels.restoreVerifiedAt}: ${details.restoreVerifiedAt}`)
  lines.push(
    `${labels.address}: ${details.address}`,
    `${labels.port}: ${details.port}`,
  )
  if (details.username) lines.push(`${labels.username}: ${details.username}`)
  if (details.password) lines.push(`${labels.password}: ${details.password}`)
  if (details.database) lines.push(`${labels.database}: ${details.database}`)
  lines.push(`${labels.uri}: ${details.uri}`)
  if (details.jdbc) lines.push(`${labels.jdbc}: ${details.jdbc}`)
  return lines.join('\n')
}
