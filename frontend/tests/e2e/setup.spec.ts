import { expect, test } from '@playwright/test'

const GiB = 1024 ** 3

const templateVersionID = '22222222-2222-4222-8222-222222222222'
const hostID = '33333333-3333-4333-8333-333333333333'
const instanceID = '44444444-4444-4444-8444-444444444444'
const createdInstanceID = '55555555-5555-4555-8555-555555555555'

const standardTemplate = {
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

const host = {
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
  architecture: 'amd64',
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
  consecutiveFailures: 0,
  labels: {},
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-04T08:00:00Z',
}

const runningInstance = {
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

test('keeps database deployment on the three-step MVP path', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000)
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (entry) => { if (entry.type() === 'error') consoleErrors.push(entry.text()) })
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })

  await page.goto('/')
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#password').fill('e2e-password')
  await page.getByRole('button', { name: '初始化 DB Mock' }).click()
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
  await expect(page.getByRole('menuitem')).toHaveCount(4)
  await expect(page.getByRole('menuitem', { name: /工作台/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /主机/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /数据库/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /任务中心/ })).toBeVisible()

  let instances = [runningInstance]
  let createPayload: Record<string, unknown> | undefined
  let stopPayload: Record<string, unknown> | undefined
  await page.route('**/api/v1/templates', (route) => route.fulfill({ json: { items: [standardTemplate, ...hiddenTemplates] } }))
  await page.route('**/api/v1/hosts', (route) => route.fulfill({ json: { items: [host] } }))
  await page.route('**/api/v1/projects', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/images', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/registries', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/instances', async (route) => {
    if (route.request().method() === 'POST') {
      createPayload = route.request().postDataJSON()
      const created = { ...runningInstance, id: createdInstanceID, name: String(createPayload?.name), status: 'provisioning', desiredState: 'running' }
      instances = [...instances, created]
      await route.fulfill({ status: 202, json: { instance: created, task: { ...succeededTask, id: '99999999-9999-4999-8999-999999999999', kind: 'instance.create', resourceId: createdInstanceID, status: 'queued', progress: 0, stage: 'queued', message: 'Queued', finishedAt: undefined } } })
      return
    }
    await route.fulfill({ json: { items: instances } })
  })
  await page.route('**/api/v1/instances/batch-actions/stop', async (route) => {
    stopPayload = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { action: 'stop', accepted: [{ instanceId: instanceID, instanceName: runningInstance.name, task: succeededTask }], rejected: [] } })
  })
  await page.route(`**/api/v1/instances/${instanceID}/connection`, (route) => route.fulfill({ json: { address: host.connectionAddress, port: 25432, username: 'dbmock', password: 'generated-secret', database: 'app', authentication: 'password', uri: 'postgresql://dbmock:generated-secret@10.0.0.8:25432/app', jdbc: 'jdbc:postgresql://10.0.0.8:25432/app' } }))
  await page.route(`**/api/v1/instances/${instanceID}/tasks`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/instances/${instanceID}/backups`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/instances/${createdInstanceID}`, (route) => route.fulfill({ json: instances.find((item) => item.id === createdInstanceID) }))
  await page.route(`**/api/v1/instances/${createdInstanceID}/tasks`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/instances/${createdInstanceID}/backups`, (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/instances/${createdInstanceID}/backup-policy`, (route) => route.fulfill({ json: { policy: null } }))

  await page.goto('/instances')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('heading', { name: '数据库' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '数据库' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Orders DB', exact: true })).toBeVisible()
  await expect(page.locator('.instance-table-card .ant-spin-spinning')).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect(page.getByRole('columnheader', { name: '环境' })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: '生命周期' })).toHaveCount(0)
  await expect(page.getByLabel('项目')).toHaveCount(0)
  await expect(page.getByLabel('环境')).toHaveCount(0)
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '复制部署' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '创建数据库' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('instances-1440.png'), fullPage: true })

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(500)
  await expect(page.getByRole('button', { name: '创建数据库' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('instances-1024.png'), fullPage: true })

  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: '复制连接交付' }).click()
  const handoff = page.getByRole('dialog', { name: '快速交付 · Orders DB' })
  await expect(handoff).toBeVisible()
  await expect(handoff.getByText('PostgreSQL 17')).toBeVisible()
  await expect(handoff.getByText('项目', { exact: true })).toHaveCount(0)
  await expect(handoff.getByText('环境', { exact: true })).toHaveCount(0)
  await expect(handoff.getByText('负责人', { exact: true })).toHaveCount(0)
  await handoff.getByRole('button', { name: '显示并复制完整摘要' }).click()
  await expect(handoff.getByText('连接交付摘要已复制')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('PostgreSQL 17')
  expect(copied).toContain('postgresql://dbmock:generated-secret@10.0.0.8:25432/app')
  expect(copied).not.toContain('项目:')
  expect(copied).not.toContain('环境:')
  await handoff.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '运行操作 · Orders DB' }).click()
  await page.getByRole('menuitem', { name: '停止' }).click()
  const stopDialog = page.getByRole('dialog', { name: '停止 Orders DB？' })
  await expect(stopDialog.getByText('停止会中断现有数据库连接')).toBeVisible()
  await stopDialog.getByRole('button', { name: '确认停止' }).click()
  await expect.poll(() => stopPayload).toEqual({ instanceIds: [instanceID] })
  const notificationClose = page.locator('.ant-notification-notice-close')
  if (await notificationClose.isVisible()) await notificationClose.click()
  await page.getByRole('button', { name: '关闭提示' }).click()
  await expect(page.getByRole('button', { name: '关闭提示' })).toHaveCount(0)

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '创建数据库' }).click()
  const drawer = page.getByRole('dialog', { name: '创建数据库' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('数据库与名称')).toBeVisible()
  await expect(drawer.getByText('资源与主机')).toBeVisible()
  await expect(drawer.getByText('确认', { exact: true })).toBeVisible()
  await expect(drawer.locator('.ant-steps-item')).toHaveCount(3)
  await expect(drawer.locator('.ant-steps-item-process')).toContainText('数据库与名称')
  await page.waitForTimeout(500)

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('create-database-step-1-1440.png'), fullPage: true })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(500)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('create-database-step-1-1024.png'), fullPage: true })

  const templateSelect = drawer.getByRole('combobox', { name: '模板 / 版本' })
  await templateSelect.click()
  await expect(page.getByText('PostgreSQL 17', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('TiDB 8.5', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Team Custom DB 1.0', { exact: true })).toHaveCount(0)
  await page.getByText('PostgreSQL 17', { exact: true }).last().click()
  await drawer.getByLabel('部署名称').fill('orders_test')
  await drawer.getByRole('button', { name: '下一步' }).click()

  await expect(drawer.locator('.ant-steps-item-process')).toContainText('资源与主机')
  await expect(drawer.getByRole('spinbutton', { name: 'CPU' })).toHaveValue(/^1(?:\.0+)?$/)
  await expect(drawer.getByRole('spinbutton', { name: '内存 GiB' })).toHaveValue(/^1(?:\.0+)?$/)
  await expect(drawer.getByRole('spinbutton', { name: '磁盘 GiB' })).toHaveValue(/^10(?:\.0+)?$/)
  await expect(drawer.getByText('将从公开仓库拉取内置模板镜像')).toBeVisible()
  for (const removedLabel of ['项目', '环境', '用途', '负责人', '预计到期时间', '监听地址', '镜像来源', '自动重启', '额外环境变量（JSON）']) {
    await expect(drawer.getByLabel(removedLabel, { exact: true })).toHaveCount(0)
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('create-database-step-2-1024.png'), fullPage: true })
  await drawer.getByRole('button', { name: '下一步' }).click()

  await expect(drawer.locator('.ant-steps-item-process')).toContainText('确认')
  await expect(drawer.getByText('orders_test')).toBeVisible()
  await expect(drawer.getByText('创建时自动生成，可在连接信息中查看')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('create-database-confirm-1024.png'), fullPage: true })
  await drawer.getByRole('button', { name: /^创\s*建$/ }).click()
  await expect.poll(() => createPayload).toEqual({
    name: 'orders_test',
    templateVersionId: templateVersionID,
    hostId: null,
    cpu: 1,
    memoryBytes: GiB,
    diskBytes: 10 * GiB,
    templateParameters: {},
  })
  await expect(page).toHaveURL(new RegExp(`/instances/${createdInstanceID}$`))
  await expect(page.getByRole('heading', { name: 'orders_test' })).toBeVisible()
  const createdNotificationClose = page.locator('.ant-notification-notice-close')
  if (await createdNotificationClose.isVisible()) await createdNotificationClose.click()
  await expect(createdNotificationClose).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('created-database-detail-1024.png'), fullPage: true })
  expect(consoleErrors).toEqual([])
  expect(httpErrors).toEqual([])
})
