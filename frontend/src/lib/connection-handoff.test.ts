import { describe, expect, it } from 'vitest'
import { connectionHandoffSummary, type ConnectionHandoffLabels } from './connection-handoff'

const labels: ConnectionHandoffLabels = {
  title: 'Test database connection',
  instance: 'Instance',
  template: 'Database',
  project: 'Project',
  environment: 'Environment',
  purpose: 'Purpose',
  owner: 'Owner',
  expectedExpiry: 'Expected expiry',
  status: 'Status',
  authentication: 'Authentication',
  dataVersion: 'Data version',
  backupCreatedAt: 'Backup created',
  restoreVerifiedAt: 'Restore verified',
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
  project: 'Checkout',
  environment: 'Testing',
  purpose: 'Orders 3.8 release regression',
  owner: 'QA Team',
  expectedExpiry: 'Aug 3, 2026, 11:59 PM',
  status: 'Running',
  authentication: 'Username and password',
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
      'Project: Checkout',
      'Environment: Testing',
      'Purpose: Orders 3.8 release regression',
      'Owner: QA Team',
      'Expected expiry: Aug 3, 2026, 11:59 PM',
      'Status: Running',
      'Authentication: Username and password',
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

  it('does not invent credentials for a database without authentication', () => {
    const summary = connectionHandoffSummary({
      ...details,
      authentication: 'No username or password',
      username: '',
      password: '',
      database: '',
      uri: 'cassandra://10.0.0.8:29042',
      jdbc: undefined,
    }, labels)

    expect(summary).toContain('Authentication: No username or password')
    expect(summary).toContain('Connection URI: cassandra://10.0.0.8:29042')
    expect(summary).not.toContain('Username:')
    expect(summary).not.toContain('Password:')
    expect(summary).not.toContain('Database name:')
  })

  it('includes durable restore evidence when the current data came from a backup', () => {
    const summary = connectionHandoffSummary({
      ...details,
      dataVersion: 'Orders release baseline',
      backupCreatedAt: 'Jul 27, 2026, 4:00 PM',
      restoreVerifiedAt: 'Jul 28, 2026, 4:01 PM',
    }, labels)

    expect(summary).toContain([
      'Status: Running',
      'Authentication: Username and password',
      'Data version: Orders release baseline',
      'Backup created: Jul 27, 2026, 4:00 PM',
      'Restore verified: Jul 28, 2026, 4:01 PM',
      'Address: 10.0.0.8',
    ].join('\n'))
  })
})
