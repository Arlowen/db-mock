import { describe, expect, it } from 'vitest'
import { connectionHandoffSummary, type ConnectionHandoffLabels } from './connection-handoff'

const labels: ConnectionHandoffLabels = {
  title: 'Test database connection',
  instance: 'Instance',
  template: 'Database',
  environment: 'Environment',
  status: 'Status',
  address: 'Address',
  port: 'Port',
  username: 'Username',
  password: 'Password',
  database: 'Database name',
  uri: 'Connection URI',
  jdbc: 'JDBC URL',
}

const details = {
  instanceName: 'Orders DB',
  templateName: 'PostgreSQL',
  templateVersion: '17',
  environment: 'Testing',
  status: 'Running',
  address: '10.0.0.8',
  port: 25432,
  username: 'app',
  password: 'e2e-secret',
  database: 'orders',
  uri: 'postgresql://app:e2e-secret@10.0.0.8:25432/orders',
  jdbc: 'jdbc:postgresql://10.0.0.8:25432/orders',
}

describe('connectionHandoffSummary', () => {
  it('builds a complete developer-ready connection handoff', () => {
    expect(connectionHandoffSummary(details, labels)).toBe([
      'Test database connection',
      'Instance: Orders DB',
      'Database: PostgreSQL 17',
      'Environment: Testing',
      'Status: Running',
      'Address: 10.0.0.8',
      'Port: 25432',
      'Username: app',
      'Password: e2e-secret',
      'Database name: orders',
      'Connection URI: postgresql://app:e2e-secret@10.0.0.8:25432/orders',
      'JDBC URL: jdbc:postgresql://10.0.0.8:25432/orders',
    ].join('\n'))
  })

  it('omits JDBC when the selected database does not expose it', () => {
    expect(connectionHandoffSummary({ ...details, jdbc: undefined }, labels)).not.toContain('JDBC URL:')
  })
})
