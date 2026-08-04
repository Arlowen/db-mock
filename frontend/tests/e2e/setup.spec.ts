import { expect, test } from '@playwright/test'
import {
  authenticate,
  createdInstanceID,
  deleteTaskID,
  expectNoOverflow,
  GiB,
  installMvpApi,
  instanceID,
  observeRuntime,
  retiredFailedTaskID,
  templateVersionID,
} from './mvp-fixture'

test.describe('DB Mock MVP workflow', () => {
  test('initializes, shows four work entries, and redirects retired routes', async ({ page }, testInfo) => {
    const diagnostics = observeRuntime(page)
    await installMvpApi(page)
    await authenticate(page, diagnostics)

    await expect(page.getByRole('menuitem')).toHaveCount(4)
    await expect(page.getByRole('menuitem', { name: /工作台/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /主机/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /数据库/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /任务中心/ })).toBeVisible()

    for (const legacyPath of ['/projects/team-a', '/catalog', '/images?tab=registries']) {
      await page.goto(legacyPath)
      await expect(page).toHaveURL(/\/instances$/)
      await expect(page.getByRole('heading', { name: '数据库' })).toBeVisible()
    }
    for (const legacyPath of ['/alerts?tab=webhooks', '/users', '/audit', '/settings/uploads']) {
      await page.goto(legacyPath)
      await expect(page).toHaveURL(/\/dashboard$/)
      await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
    }
    await page.goto('/removed-feature')
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.getByRole('heading', { name: '工作台' })).toHaveCount(1)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('dashboard-1440.png'), fullPage: true })
    await page.setViewportSize({ width: 1024, height: 768 })
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('dashboard-1024.png'), fullPage: true })

    await page.goto('/tasks')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.getByRole('heading', { name: '任务中心' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '删除数据库实例' })).toBeVisible()
    const coreFailedRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: '重启数据库实例' }) })
    const retiredFailedRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: '升级数据库实例' }) })
    await expect(coreFailedRow.getByRole('button', { name: /重试$/ })).toBeVisible()
    await expect(retiredFailedRow.getByRole('button', { name: /重试$/ })).toHaveCount(0)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('tasks-retry-boundary-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 1024, height: 768 })
    const retiredFailedCard = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: '升级数据库实例' }) })
    await expect(retiredFailedCard).toBeVisible()
    await expect(retiredFailedCard.getByRole('button', { name: /重试$/ })).toHaveCount(0)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('tasks-retry-boundary-1024.png'), fullPage: true })
    await retiredFailedCard.getByRole('button', { name: '升级数据库实例' }).click()
    await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${retiredFailedTaskID}$`))
    const retiredDrawer = page.getByRole('dialog', { name: /升级数据库实例/ })
    await expect(retiredDrawer).toBeVisible()
    await expect(retiredDrawer.getByRole('button', { name: '重试任务' })).toHaveCount(0)
    await expect(retiredDrawer.getByText('Historical upgrade task is no longer retryable')).toBeVisible()
    await expectNoOverflow(page)
    await page.waitForTimeout(500)
    await page.screenshot({ path: testInfo.outputPath('retired-task-detail-1024.png'), fullPage: false })
    await retiredDrawer.getByRole('button', { name: '关闭' }).click()
    await expect(page.getByRole('button', { name: '重启数据库实例' })).toBeVisible()
    await expect(page.getByRole('button', { name: '升级数据库实例' })).toBeVisible()
    expect(diagnostics.consoleErrors).toEqual([])
    expect(diagnostics.httpErrors).toEqual([])
  })

  test('connects, inspects, and protects a Docker host', async ({ page }, testInfo) => {
    const diagnostics = observeRuntime(page)
    const state = await installMvpApi(page)
    await authenticate(page, diagnostics)
    state.hostSupportingRequests = 0

    await page.goto('/hosts')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.getByRole('heading', { name: '主机' })).toHaveCount(1)
    const hostLink = page.locator('.host-table-card .description-link', { hasText: 'Daily Docker Host' })
    await expect(hostLink).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '项目' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '重新检测 Daily Docker Host' })).toBeVisible()
    await expect(page.getByRole('button', { name: '编辑 Daily Docker Host' })).toBeVisible()
    await expect.poll(() => state.hostSupportingRequests).toBe(0)
    await expect.poll(() => state.removedFeatureRequests).toBe(0)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('hosts-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(page.getByRole('button', { name: '接入主机' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '调度容量' })).toHaveCount(0)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('hosts-1024.png'), fullPage: true })

    await hostLink.click()
    const hostDrawer = page.locator('.host-detail-drawer')
    await expect(hostDrawer).toBeVisible()
    await expect(hostDrawer.getByText('当前主机状态')).toBeVisible()
    await expect(hostDrawer.getByText('托管数据库')).toBeVisible()
    await expect(hostDrawer.getByText('主机配置')).toBeVisible()
    await expect(hostDrawer.getByText('项目', { exact: true })).toHaveCount(0)
    await expect(hostDrawer.getByText('主机策略', { exact: true })).toHaveCount(0)
    await expect(hostDrawer.getByRole('button', { name: '删除' })).toBeDisabled()
    await expect(hostDrawer.getByRole('button', { name: '删除' })).toHaveAttribute('title', '必须先删除该主机上的托管实例。')
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('host-detail-1024.png'), fullPage: false })
    await hostDrawer.getByRole('button', { name: '关闭' }).click()

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '接入主机' }).click()
    const hostEditor = page.getByRole('dialog', { name: '接入主机' })
    await expect(hostEditor).toBeVisible()
    await expect(hostEditor.getByText('SSH 连接')).toBeVisible()
    await expect(hostEditor.getByText('数据库部署位置')).toBeVisible()
    for (const removedHostSetting of ['项目', '高级设置', '代理', '主机策略', '允许安装或升级 Docker', '维护模式']) {
      await expect(hostEditor.getByText(removedHostSetting, { exact: true })).toHaveCount(0)
    }
    await hostEditor.getByLabel('名称').fill('Staging Docker Host')
    await hostEditor.getByLabel('SSH 地址').fill('10.0.0.9')
    await hostEditor.getByLabel('SSH 用户').fill('dbmock')
    await hostEditor.getByLabel('认证方式').click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '密码' }).click()
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)
    await hostEditor.getByLabel('密码').fill('synthetic-e2e-password')
    await hostEditor.getByRole('button', { name: '测试连接' }).click()
    await expect(hostEditor.getByText('连接验证通过')).toBeVisible()
    await expect(hostEditor.getByText('Docker 与 Compose')).toBeVisible()
    const saveHostButton = hostEditor.getByRole('button', { name: /^保\s*存$/ })
    await expect(saveHostButton).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('host-editor-verified-1440.png'), fullPage: false })

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect.poll(() => hostEditor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('host-editor-verified-1024.png'), fullPage: false })
    await saveHostButton.click()
    await expect(hostEditor).toBeHidden()
    await expect.poll(() => state.hostCreatePayload).toEqual({
      name: 'Staging Docker Host',
      sshAddress: '10.0.0.9',
      sshPort: 22,
      sshUser: 'dbmock',
      authType: 'password',
      credential: 'synthetic-e2e-password',
      connectionAddress: '',
      dataRoot: '/opt/dbmock',
      portStart: 20000,
      portEnd: 40000,
      manageDocker: false,
      proxyHttp: '',
      proxyHttps: '',
      proxyNoProxy: '',
      maintenance: false,
      autoRestartDefault: true,
      labels: {},
      verificationToken: 'e2e-host-verification-token',
    })
    expect(diagnostics.consoleErrors).toEqual([])
    expect(diagnostics.httpErrors).toEqual([])
  })

  test('delivers connection details, lifecycle controls, logs, and safe deletion', async ({ page, context }, testInfo) => {
    const diagnostics = observeRuntime(page)
    const state = await installMvpApi(page)
    await authenticate(page, diagnostics)

    await page.goto('/instances')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.getByRole('heading', { name: '数据库' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Orders DB', exact: true })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '环境' })).toHaveCount(0)
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '复制部署' })).toHaveCount(0)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('instances-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(page.getByRole('button', { name: '创建数据库' })).toBeVisible()
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('instances-1024.png'), fullPage: true })

    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByRole('button', { name: '复制连接交付' }).click()
    const handoff = page.getByRole('dialog', { name: '快速交付 · Orders DB' })
    await expect(handoff).toBeVisible()
    await handoff.getByRole('button', { name: '显示并复制完整摘要' }).click()
    await expect(handoff.getByText('连接交付摘要已复制')).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain('PostgreSQL 17')
    expect(copied).toContain('postgresql://dbmock:generated-secret@10.0.0.8:25432/app')
    expect(copied).not.toContain('项目:')
    await handoff.getByRole('button', { name: '关闭', exact: true }).click()

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: 'Orders DB', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Orders DB' })).toHaveCount(1)
    await expect(page.getByRole('tab')).toHaveCount(3)
    await expect(page.getByRole('tab', { name: '概览' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '连接信息' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '日志' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '监控' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '备份' })).toHaveCount(0)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('database-overview-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 1024, height: 768 })
    await page.getByRole('tab', { name: '连接信息' }).click()
    await page.getByRole('button', { name: '显示连接信息' }).click()
    await expect(page.getByText('postgresql://dbmock:generated-secret@10.0.0.8:25432/app')).toBeVisible()
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('database-connection-1024.png'), fullPage: true })

    await page.getByRole('tab', { name: '日志' }).click()
    await expect(page.getByText('accepting connections', { exact: false })).toBeVisible()
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('database-logs-1024.png'), fullPage: true })

    await page.getByRole('tab', { name: '概览' }).click()
    await page.locator('.instance-detail-actions').getByRole('button', { name: /删除/ }).click()
    const deleteDialog = page.getByRole('dialog', { name: '删除数据库 · Orders DB' })
    await expect(deleteDialog).toBeVisible()
    await expect(deleteDialog.getByText('先处理阻止删除的托管备份')).toBeVisible()
    await expect(deleteDialog.getByText('nightly-before-release')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: testInfo.outputPath('database-delete-blocked-1024.png'), fullPage: false })
    await deleteDialog.getByRole('button', { name: '删除备份' }).click()
    const backupDeleteDialog = page.getByRole('dialog', { name: '删除备份 · nightly-before-release' })
    await backupDeleteDialog.getByLabel('输入备份名确认删除').fill('nightly-before-release')
    await backupDeleteDialog.getByRole('button', { name: '删除备份' }).click()
    await expect.poll(() => state.backupDeletePayload).toEqual({ confirmName: 'nightly-before-release' })
    await expect(deleteDialog.getByText('将永久删除数据库及其数据')).toBeVisible()
    const notificationClose = page.locator('.ant-notification-notice-close')
    if (await notificationClose.isVisible()) await notificationClose.click()
    const confirmDelete = deleteDialog.getByRole('button', { name: '确认永久删除' })
    await deleteDialog.getByLabel('输入实例名称 Orders DB 确认删除').fill('orders-db')
    await expect(confirmDelete).toBeDisabled()
    await deleteDialog.getByLabel('输入实例名称 Orders DB 确认删除').fill('Orders DB')
    await confirmDelete.click()
    await expect.poll(() => state.deletePayload).toEqual({ confirmName: 'Orders DB' })
    await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${deleteTaskID}$`))

    await page.goto('/instances')
    await page.getByRole('button', { name: '运行操作 · Orders DB' }).click()
    await page.getByRole('menuitem', { name: '停止' }).click()
    const stopDialog = page.getByRole('dialog', { name: '停止 Orders DB？' })
    await expect(stopDialog.getByText('停止会中断现有数据库连接')).toBeVisible()
    await stopDialog.getByRole('button', { name: '确认停止' }).click()
    await expect.poll(() => state.stopPayload).toEqual({ instanceIds: [instanceID] })
    expect(diagnostics.consoleErrors).toEqual([])
    expect(diagnostics.httpErrors).toEqual([])
  })

  test('creates a database through the three-step minimum form', async ({ page }, testInfo) => {
    const diagnostics = observeRuntime(page)
    const state = await installMvpApi(page)
    await authenticate(page, diagnostics)
    await page.goto('/instances')

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '创建数据库' }).click()
    const drawer = page.getByRole('dialog', { name: '创建数据库' })
    await expect(drawer.locator('.ant-steps-item')).toHaveCount(3)
    await expect(drawer.locator('.ant-steps-item-process')).toContainText('数据库与名称')
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('create-database-step-1-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 1024, height: 768 })
    await expectNoOverflow(page)
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
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('create-database-step-2-1024.png'), fullPage: true })
    await drawer.getByRole('button', { name: '下一步' }).click()

    await expect(drawer.locator('.ant-steps-item-process')).toContainText('确认')
    await expect(drawer.getByText('orders_test')).toBeVisible()
    await expect(drawer.getByText('创建时自动生成，可在连接信息中查看')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('create-database-confirm-1024.png'), fullPage: true })
    await drawer.getByRole('button', { name: /^创\s*建$/ }).click()
    await expect.poll(() => state.createPayload).toEqual({
      name: 'orders_test',
      templateVersionId: templateVersionID,
      hostId: null,
      cpu: 1,
      memoryBytes: GiB,
      diskBytes: 10 * GiB,
      templateParameters: {},
    })
    await expect.poll(() => state.removedFeatureRequests).toBe(0)
    await expect(page).toHaveURL(new RegExp(`/instances/${createdInstanceID}$`))
    await expect(page.getByRole('heading', { name: 'orders_test' })).toHaveCount(1)
    await expect(page.getByRole('tab')).toHaveCount(3)
    await expectNoOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('created-database-detail-1024.png'), fullPage: true })
    expect(diagnostics.consoleErrors).toEqual([])
    expect(diagnostics.httpErrors).toEqual([])
  })
})
