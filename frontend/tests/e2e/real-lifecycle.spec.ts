import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { expectNoOverflow, observeRuntime } from './mvp-fixture'

interface APIResult<T> { status: number; body: T }
interface HostSummary { id: string; name: string; status: string }
interface InstanceSummary { id: string; name: string; status: string }
interface TaskSummary { id: string; status: string; errorMessage?: string }
interface ConnectionDetails { address: string; port: number; username: string; password: string; database: string; uri: string; jdbc?: string }

const enabled = process.env.DBMOCK_REAL_LIFECYCLE === '1'
const sshPassword = process.env.DBMOCK_REAL_SSH_PASSWORD || ''
const sshAddress = process.env.DBMOCK_REAL_SSH_ADDRESS || '127.0.0.1'
const sshPort = Number(process.env.DBMOCK_REAL_SSH_PORT || 22)
const sshUser = process.env.DBMOCK_REAL_SSH_USER || 'root'
const connectionAddress = process.env.DBMOCK_REAL_CONNECTION_ADDRESS || '127.0.0.1'
const dataRoot = process.env.DBMOCK_REAL_DATA_ROOT || '/tmp/dbmock-real-lifecycle'
const hostName = process.env.DBMOCK_REAL_HOST_NAME || 'Disposable Docker Host'
const instanceName = process.env.DBMOCK_REAL_INSTANCE_NAME || 'mvp_real_postgres'

async function api<T>(page: Page, path: string): Promise<APIResult<T>> {
  return page.evaluate(async (target) => {
    const response = await fetch(`/api/v1${target}`)
    const body = await response.json() as T
    return { status: response.status, body }
  }, path)
}

async function waitForTask(page: Page, id: string) {
  await expect.poll(async () => {
    const result = await api<TaskSummary>(page, `/tasks/${id}`)
    if (result.body.status === 'failed') throw new Error(result.body.errorMessage || `task ${id} failed`)
    return result.body.status
  }, { timeout: 8 * 60_000, intervals: [500, 1000, 2000] }).toBe('succeeded')
}

async function waitForInstance(page: Page, id: string, status: string) {
  await expect.poll(async () => (await api<InstanceSummary>(page, `/instances/${id}`)).body.status,
    { timeout: 3 * 60_000, intervals: [500, 1000, 2000] }).toBe(status)
}

async function runLifecycleAction(page: Page, instanceID: string, action: 'start' | 'stop' | 'restart') {
  const labels = {
    start: { button: '启动', confirm: '确认启动' },
    stop: { button: '停止', confirm: '确认停止' },
    restart: { button: '重启', confirm: '确认重启' },
  }[action]
  await page.getByRole('tablist').getByRole('button', { name: new RegExp(`${labels.button}$`) }).click()
  const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/v1/instances/${instanceID}/actions/${action}`) && response.request().method() === 'POST')
  await page.getByRole('dialog').getByRole('button', { name: labels.confirm }).click()
  const response = await responsePromise
  expect(response.status()).toBe(202)
  const task = await response.json() as TaskSummary
  await waitForTask(page, task.id)
}

test.describe('DB Mock real SSH lifecycle', () => {
  test.skip(!enabled || !sshPassword, 'Set DBMOCK_REAL_LIFECYCLE=1 and disposable SSH credentials to run')

  test('deploys, connects, operates, logs, and deletes PostgreSQL 17', async ({ page }, testInfo) => {
    test.setTimeout(12 * 60_000)
    const diagnostics = observeRuntime(page)

    await page.goto('/')
    await page.locator('#username').fill('real-e2e-admin')
    await page.locator('#password').fill('real-e2e-password')
    const initialize = page.getByRole('button', { name: '初始化 DB Mock' })
    if (await initialize.count()) await initialize.click()
    else await page.getByRole('button', { name: /^登\s*录$/ }).click()
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
    diagnostics.clear()

    await page.goto('/hosts')
    await page.getByRole('button', { name: '接入主机' }).click()
    const hostEditor = page.getByRole('dialog', { name: '接入主机' })
    await hostEditor.getByLabel('名称').fill(hostName)
    await hostEditor.getByLabel('SSH 地址').fill(sshAddress)
    await hostEditor.getByLabel('SSH 端口').fill(String(sshPort))
    await hostEditor.getByLabel('SSH 用户').fill(sshUser)
    await hostEditor.getByLabel('认证方式').click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '密码' }).click()
    await hostEditor.getByLabel('密码').fill(sshPassword)
    await hostEditor.getByLabel('数据库连接地址').fill(connectionAddress)
    await hostEditor.getByLabel('托管数据根目录').fill(dataRoot)
    await hostEditor.getByLabel('端口池起始值').fill('25520')
    await hostEditor.getByLabel('端口池结束值').fill('25529')
    await hostEditor.getByRole('button', { name: '测试连接' }).click()
    await expect(hostEditor.getByText('连接验证通过')).toBeVisible({ timeout: 60_000 })
    await hostEditor.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(hostEditor).toBeHidden()

    let hostID = ''
    await expect.poll(async () => {
      const result = await api<{ items: HostSummary[] }>(page, '/hosts')
      const host = result.body.items.find((item) => item.name === hostName)
      hostID = host?.id || ''
      return host?.status
    }, { timeout: 2 * 60_000, intervals: [500, 1000, 2000] }).toBe('online')
    expect(hostID).not.toBe('')

    await page.goto('/instances')
    await page.getByRole('button', { name: '创建数据库' }).click()
    const createDrawer = page.getByRole('dialog', { name: '创建数据库' })
    const templateSelect = createDrawer.getByRole('combobox', { name: '模板 / 版本' })
    await templateSelect.fill('PostgreSQL')
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'PostgreSQL 17' }).click()
    await createDrawer.getByLabel('部署名称').fill(instanceName)
    await createDrawer.getByRole('button', { name: '下一步' }).click()
    await expect(createDrawer.getByText(hostName)).toBeVisible()
    await createDrawer.getByRole('button', { name: '下一步' }).click()
    const createResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/instances') && response.request().method() === 'POST')
    await createDrawer.getByRole('button', { name: /^创\s*建$/ }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.status()).toBe(202)
    const created = await createResponse.json() as { instance: InstanceSummary; task: TaskSummary }
    await expect(page).toHaveURL(new RegExp(`/instances/${created.instance.id}$`))
    await waitForTask(page, created.task.id)
    await waitForInstance(page, created.instance.id, 'running')
    await page.reload()
    await expect(page.getByRole('heading', { name: instanceName })).toHaveCount(1)

    await page.getByRole('tab', { name: '连接信息' }).click()
    await page.getByRole('button', { name: '显示连接信息' }).click()
    const connection = (await api<ConnectionDetails>(page, `/instances/${created.instance.id}/connection`)).body
    await expect(page.getByText(connectionAddress, { exact: true })).toBeVisible()
    await expect(page.getByText(String(connection.port), { exact: true })).toBeVisible()
    const sql = execFileSync('docker', [
      'run', '--rm', '-e', 'PGPASSWORD', 'postgres:17-alpine', 'psql',
      '-h', process.env.DBMOCK_REAL_SQL_HOST || 'host.docker.internal', '-p', String(connection.port),
      '-U', connection.username, '-d', connection.database, '-Atc', 'SELECT 1',
    ], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: connection.password } }).trim()
    expect(sql).toBe('1')

    await page.getByRole('tab', { name: '日志' }).click()
    await expect(page.locator('.log-viewer')).toContainText(/database system is ready|ready to accept connections/i, { timeout: 30_000 })

    await page.getByRole('tab', { name: '概览' }).click()
    await runLifecycleAction(page, created.instance.id, 'stop')
    await waitForInstance(page, created.instance.id, 'stopped')
    await page.reload()
    await runLifecycleAction(page, created.instance.id, 'start')
    await waitForInstance(page, created.instance.id, 'running')
    await page.reload()
    await runLifecycleAction(page, created.instance.id, 'restart')
    await waitForInstance(page, created.instance.id, 'running')
    await page.reload()

    await page.setViewportSize({ width: 1440, height: 1000 })
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('real-postgres-running-1440.png'), fullPage: true })
    await page.setViewportSize({ width: 1024, height: 768 })
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('real-postgres-running-1024.png'), fullPage: true })

    await page.getByRole('tablist').getByRole('button', { name: /删除$/ }).click()
    const deleteDialog = page.getByRole('dialog', { name: `删除数据库 · ${instanceName}` })
    await expect(deleteDialog.getByText('将永久删除数据库及其数据')).toBeVisible()
    await deleteDialog.getByLabel(`输入实例名称 ${instanceName} 确认删除`).fill(instanceName)
    const deleteResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/v1/instances/${created.instance.id}/actions/delete`) && response.request().method() === 'POST')
    await deleteDialog.getByRole('button', { name: '确认永久删除' }).click()
    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.status()).toBe(202)
    const deleteTask = await deleteResponse.json() as TaskSummary
    await waitForTask(page, deleteTask.id)
    await expect(page.getByRole('button', { name: '删除数据库实例' })).toBeVisible()

    expect(diagnostics.consoleErrors).toEqual([])
    expect(diagnostics.httpErrors).toEqual([])
  })
})
