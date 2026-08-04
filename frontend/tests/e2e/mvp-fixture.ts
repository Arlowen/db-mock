import { expect, type Page } from '@playwright/test'

export const GiB = 1024 ** 3
export const templateVersionID = '22222222-2222-4222-8222-222222222222'
export const hostID = '33333333-3333-4333-8333-333333333333'
export const createdHostID = '33333333-3333-4333-8333-333333333334'
export const instanceID = '44444444-4444-4444-8444-444444444444'
export const createdInstanceID = '55555555-5555-4555-8555-555555555555'
export const deleteTaskID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const coreFailedTaskID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
export const retiredFailedTaskID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const backupID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const backupDeleteTaskID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

export const standardTemplate = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'postgresql',
  name: 'PostgreSQL',
  nameZh: 'PostgreSQL',
  description: 'Advanced open source relational database',
  category: 'relational',
  tier: 'standard',
  builtin: true,
  icon: 'PG',
  riskReport: [],
  versions: [{
    id: templateVersionID,
    templateId: '11111111-1111-4111-8111-111111111111',
    version: '17',
    imageReference: 'postgres:17',
    architectures: ['amd64', 'arm64'],
    minCpu: 1,
    minMemoryBytes: GiB,
    minDiskBytes: 10 * GiB,
    defaultPort: 5432,
    manifest: {
      username: 'dbmock',
      database: 'app',
      authentication: 'password',
      imageReferences: ['postgres:17'],
      resourceProfiles: [{ name: 'small', labelZh: '日常测试', cpu: 1, memoryBytes: GiB, diskBytes: 10 * GiB }],
    },
    riskReport: [],
    selectable: true,
    deploymentCount: 4,
    lastDeployedAt: '2026-08-04T08:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
  }],
}

const hiddenTemplates = [
  { ...standardTemplate, id: '66666666-6666-4666-8666-666666666666', slug: 'tidb', name: 'TiDB', nameZh: 'TiDB', tier: 'experimental', versions: [{ ...standardTemplate.versions[0], id: '66666666-6666-4666-8666-666666666667', templateId: '66666666-6666-4666-8666-666666666666', version: '8.5' }] },
  { ...standardTemplate, id: '77777777-7777-4777-8777-777777777777', slug: 'custom-db', name: 'Team Custom DB', nameZh: '团队自定义数据库', tier: 'custom', builtin: false, versions: [{ ...standardTemplate.versions[0], id: '77777777-7777-4777-8777-777777777778', templateId: '77777777-7777-4777-8777-777777777777', version: '1.0' }] },
]

export const host = {
  id: hostID,
  name: 'Daily Docker Host',
  sshAddress: '10.0.0.8',
  sshPort: 22,
  sshUser: 'dbmock',
  authType: 'password',
  connectionAddress: '10.0.0.8',
  dataRoot: '/opt/dbmock',
  portStart: 20000,
  portEnd: 40000,
  manageDocker: false,
  os: 'linux',
  distro: 'Ubuntu 24.04',
  architecture: 'amd64',
  dockerVersion: '27.5.1',
  composeVersion: '2.32.4',
  cpuCount: 8,
  memoryBytes: 16 * GiB,
  diskTotalBytes: 200 * GiB,
  diskFreeBytes: 160 * GiB,
  dataRootWritable: true,
  portProbeAvailable: true,
  availablePort: 25432,
  status: 'online',
  maintenance: false,
  autoRestartDefault: true,
  lastSeenAt: '2026-08-04T08:10:00Z',
  lastCheckedAt: '2026-08-04T08:10:00Z',
  consecutiveFailures: 0,
  labels: {},
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-04T08:00:00Z',
}

export const runningInstance = {
  id: instanceID,
  name: 'Orders DB',
  hostId: hostID,
  templateVersionId: templateVersionID,
  environment: 'development',
  labels: {},
  status: 'running',
  desiredState: 'running',
  autoRestart: true,
  restartFailures: 0,
  cpu: 1,
  memoryBytes: GiB,
  reservedDiskBytes: 10 * GiB,
  hostPort: 25432,
  containerPort: 5432,
  bindAddress: '0.0.0.0',
  databaseUsername: 'dbmock',
  databaseName: 'app',
  configuration: { templateParameters: {} },
  templateSlug: 'postgresql',
  templateName: 'PostgreSQL',
  templateVersion: '17',
  hostName: host.name,
  connectionAddress: host.connectionAddress,
  createdAt: '2026-08-04T08:00:00Z',
  updatedAt: '2026-08-04T08:05:00Z',
  lastHealthyAt: '2026-08-04T08:05:00Z',
}

const succeededTask = {
  id: '88888888-8888-4888-8888-888888888888',
  kind: 'instance.stop',
  status: 'succeeded',
  resourceType: 'instance',
  resourceId: instanceID,
  hostId: hostID,
  progress: 100,
  stage: 'succeeded',
  message: 'Stopped',
  payload: {},
  result: {},
  cancelable: false,
  cancelAsked: false,
  attempts: 1,
  createdAt: '2026-08-04T08:00:00Z',
  finishedAt: '2026-08-04T08:01:00Z',
}

export interface MvpApiState {
  hostCreatePayload?: Record<string, unknown>
  hostSupportingRequests: number
  removedFeatureRequests: number
  createPayload?: Record<string, unknown>
  stopPayload?: Record<string, unknown>
  deletePayload?: Record<string, unknown>
  backupDeletePayload?: Record<string, unknown>
}

export interface RuntimeDiagnostics {
  consoleErrors: string[]
  httpErrors: string[]
  clear: () => void
}

export function observeRuntime(page: Page): RuntimeDiagnostics {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (entry) => { if (entry.type() === 'error') consoleErrors.push(entry.text()) })
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })
  return { consoleErrors, httpErrors, clear: () => { consoleErrors.length = 0; httpErrors.length = 0 } }
}

export async function installMvpApi(page: Page): Promise<MvpApiState> {
  const state: MvpApiState = { hostSupportingRequests: 0, removedFeatureRequests: 0 }
  let instances = [runningInstance]
  let hosts = [host]
  let managedBackups = [{
    id: backupID,
    instanceId: instanceID,
    hostId: hostID,
    templateVersionId: templateVersionID,
    templateVersion: '17',
    name: 'nightly-before-release',
    creationType: 'manual',
    status: 'ready',
    sizeBytes: 32 * 1024 ** 2,
    createdBy: 'e2e-admin',
    createdByUsername: 'e2e-admin',
    createdAt: '2026-08-04T07:00:00Z',
    updatedAt: '2026-08-04T07:02:00Z',
  }]

  await page.route('**/api/v1/templates', (route) => { state.hostSupportingRequests += 1; return route.fulfill({ json: { items: [standardTemplate, ...hiddenTemplates] } }) })
  await page.route('**/api/v1/hosts', async (route) => {
    if (route.request().method() === 'POST') {
      state.hostCreatePayload = route.request().postDataJSON()
      const createdHost = { ...host, id: createdHostID, name: String(state.hostCreatePayload?.name), sshAddress: String(state.hostCreatePayload?.sshAddress), connectionAddress: String(state.hostCreatePayload?.connectionAddress || state.hostCreatePayload?.sshAddress), status: 'pending' }
      hosts = [...hosts, createdHost]
      await route.fulfill({ status: 202, json: { host: createdHost, task: { ...succeededTask, id: '33333333-3333-4333-8333-333333333335', kind: 'host.probe', resourceType: 'host', resourceId: createdHostID, status: 'queued', progress: 0, stage: 'queued', message: 'Queued', finishedAt: undefined } } })
      return
    }
    await route.fulfill({ json: { items: hosts } })
  })
  await page.route('**/api/v1/projects', (route) => { state.removedFeatureRequests += 1; return route.fulfill({ json: { items: [] } }) })
  await page.route('**/api/v1/images', (route) => { state.removedFeatureRequests += 1; return route.fulfill({ json: { items: [] } }) })
  await page.route('**/api/v1/registries', (route) => { state.removedFeatureRequests += 1; return route.fulfill({ json: { items: [] } }) })
  await page.route('**/api/v1/dashboard', (route) => route.fulfill({ json: {
    hosts: { online: hosts.length },
    instances: { running: instances.length },
    activeTasks: 0,
    attentionItems: [],
  } }))
  await page.route('**/api/v1/instances', async (route) => {
    if (route.request().method() === 'POST') {
      state.createPayload = route.request().postDataJSON()
      const created = { ...runningInstance, id: createdInstanceID, name: String(state.createPayload?.name), status: 'provisioning', desiredState: 'running' }
      instances = [...instances, created]
      await route.fulfill({ status: 202, json: { instance: created, task: { ...succeededTask, id: '99999999-9999-4999-8999-999999999999', kind: 'instance.create', resourceId: createdInstanceID, status: 'queued', progress: 0, stage: 'queued', message: 'Queued', finishedAt: undefined } } })
      return
    }
    await route.fulfill({ json: { items: instances } })
  })
  await page.route(`**/api/v1/instances?hostId=${hostID}`, (route) => route.fulfill({ json: { items: [runningInstance] } }))
  await page.route(`**/api/v1/tasks?resourceType=host&resourceId=${hostID}`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/hosts/test', (route) => route.fulfill({ json: {
    hostKey: 'SHA256:e2e-host-fingerprint ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
    os: 'linux',
    distro: 'Ubuntu 24.04',
    architecture: 'amd64',
    dockerVersion: '27.5.1',
    composeVersion: '2.32.4',
    passwordlessSudo: false,
    cpuCount: 8,
    memoryBytes: 16 * GiB,
    diskTotalBytes: 200 * GiB,
    diskFreeBytes: 160 * GiB,
    dataRootWritable: true,
    portProbeAvailable: true,
    firstAvailablePort: 25433,
    verificationToken: 'e2e-host-verification-token',
    verificationExpiresAt: '2026-08-04T09:00:00Z',
  } }))
  await page.route(`**/api/v1/hosts/${hostID}/actions/probe`, (route) => route.fulfill({ status: 202, json: { ...succeededTask, id: '33333333-3333-4333-8333-333333333336', kind: 'host.probe', resourceType: 'host', resourceId: hostID, status: 'queued', progress: 0, stage: 'queued', message: 'Queued', finishedAt: undefined } }))
  await page.route('**/api/v1/instances/batch-actions/stop', async (route) => {
    state.stopPayload = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { action: 'stop', accepted: [{ instanceId: instanceID, instanceName: runningInstance.name, task: succeededTask }], rejected: [] } })
  })
  const deleteTask = { ...succeededTask, id: deleteTaskID, kind: 'instance.delete', status: 'queued', progress: 0, stage: 'queued', message: 'Queued', finishedAt: undefined }
  const coreFailedTask = { ...succeededTask, id: coreFailedTaskID, kind: 'instance.restart', status: 'failed', progress: 70, stage: 'compose', message: 'Restart failed', errorCode: 'task_failed', errorMessage: 'Docker Compose restart failed', finishedAt: '2026-08-04T08:08:00Z' }
  const retiredFailedTask = { ...succeededTask, id: retiredFailedTaskID, kind: 'instance.upgrade', status: 'failed', progress: 45, stage: 'image', message: 'Upgrade stopped', errorCode: 'task_failed', errorMessage: 'Historical upgrade task is no longer retryable', finishedAt: '2026-08-04T08:07:00Z' }
  await page.route('**/api/v1/tasks', (route) => route.fulfill({ json: { items: [retiredFailedTask, coreFailedTask, deleteTask] } }))
  await page.route(`**/api/v1/tasks/${deleteTaskID}`, (route) => route.fulfill({ json: deleteTask }))
  await page.route(`**/api/v1/tasks/${deleteTaskID}/logs`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/tasks/${coreFailedTaskID}`, (route) => route.fulfill({ json: coreFailedTask }))
  await page.route(`**/api/v1/tasks/${coreFailedTaskID}/logs`, (route) => route.fulfill({ json: { items: [{ id: 1, level: 'error', message: 'Docker Compose restart failed', createdAt: '2026-08-04T08:08:00Z' }] } }))
  await page.route(`**/api/v1/tasks/${retiredFailedTaskID}`, (route) => route.fulfill({ json: retiredFailedTask }))
  await page.route(`**/api/v1/tasks/${retiredFailedTaskID}/logs`, (route) => route.fulfill({ json: { items: [{ id: 2, level: 'error', message: 'Historical upgrade task is no longer retryable', createdAt: '2026-08-04T08:07:00Z' }] } }))
  await page.route(`**/api/v1/instances/${instanceID}`, (route) => route.fulfill({ json: runningInstance }))
  await page.route(`**/api/v1/instances/${instanceID}/connection`, (route) => route.fulfill({ json: { address: host.connectionAddress, port: 25432, username: 'dbmock', password: 'generated-secret', database: 'app', authentication: 'password', uri: 'postgresql://dbmock:generated-secret@10.0.0.8:25432/app', jdbc: 'jdbc:postgresql://10.0.0.8:25432/app' } }))
  await page.route(`**/api/v1/instances/${instanceID}/logs**`, (route) => route.fulfill({ contentType: 'text/plain', body: '2026-08-04T08:05:00Z database ready\n2026-08-04T08:05:02Z accepting connections\n' }))
  await page.route(`**/api/v1/instances/${instanceID}/tasks`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/instances/${instanceID}/backups`, (route) => route.fulfill({ json: { items: managedBackups } }))
  await page.route(`**/api/v1/instances/${instanceID}/cleanup-review`, (route) => route.fulfill({ json: { instanceId: instanceID, instanceName: runningInstance.name, status: 'running', purpose: '', owner: '', backupCount: managedBackups.length, deleteReady: managedBackups.length === 0, blockers: managedBackups.length ? ['backups_present'] : [] } }))
  await page.route(`**/api/v1/instances/${instanceID}/backups/${backupID}/delete`, async (route) => {
    state.backupDeletePayload = route.request().postDataJSON()
    const deletedBackup = { ...managedBackups[0], status: 'deleting' }
    managedBackups = []
    await route.fulfill({ status: 202, json: { backup: deletedBackup, task: { ...deleteTask, id: backupDeleteTaskID, kind: 'instance.backup.delete', resourceType: 'backup', resourceId: backupID } } })
  })
  await page.route(`**/api/v1/instances/${instanceID}/actions/delete`, async (route) => {
    state.deletePayload = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: deleteTask })
  })
  await page.route(`**/api/v1/instances/${createdInstanceID}`, (route) => route.fulfill({ json: instances.find((item) => item.id === createdInstanceID) }))
  await page.route(`**/api/v1/instances/${createdInstanceID}/tasks`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/instances/${createdInstanceID}/backups`, (route) => route.fulfill({ json: { items: [] } }))
  return state
}

export async function authenticate(page: Page, diagnostics: RuntimeDiagnostics) {
  await page.goto('/')
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#password').fill('e2e-password')
  const initializeButton = page.getByRole('button', { name: '初始化 DB Mock' })
  if (await initializeButton.count()) await initializeButton.click()
  else await page.getByRole('button', { name: /^登\s*录$/ }).click()
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
  diagnostics.clear()
}

export async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
}
