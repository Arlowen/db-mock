import { expect, test } from '@playwright/test'

test('initializes the platform and switches the embedded interface language', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#displayName').fill('E2E Admin')
  await page.locator('#password').fill('e2e-password')
  await page.getByRole('button', { name: '初始化 DB Mock' }).click()
  await expect(page.getByText('总览', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('完成首次数据库部署', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content')
  await expect(page.getByRole('button', { name: '账号菜单' })).toBeVisible()
  await expect(page.getByText('系统设置', { exact: true })).toBeVisible()
  await page.locator('.page-header').getByRole('button', { name: '接入主机' }).click()
  const hostDialog = page.getByRole('dialog', { name: '接入主机' })
  await expect(hostDialog).toBeVisible()
  await expect(hostDialog.getByLabel('SSH 用户')).toHaveValue('')
  await expect(hostDialog.getByLabel('私钥口令')).toHaveValue('')
  await expect(hostDialog.getByRole('button', { name: /保\s*存/ })).toBeDisabled()
  await expect(hostDialog.getByText('保存前请测试 SSH 连接，平台会确认主机身份并检测系统、Docker 与可用资源。')).toBeVisible()
  await hostDialog.getByRole('button', { name: '测试连接' }).click()
  await expect(hostDialog.getByLabel('SSH 地址')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.ant-message-notice-content').filter({ hasText: '[object Object]' })).toHaveCount(0)
  await page.route('**/api/v1/hosts/test', async (route) => route.fulfill({ json: { hostKey: 'SHA256:e2e-host-key AAAA', os: 'linux', distro: 'ubuntu:24.04', architecture: 'amd64', dockerVersion: '27.5.1', composeVersion: '2.35.1', cpuCount: 8, memoryBytes: 17179869184, diskTotalBytes: 107374182400, diskFreeBytes: 85899345920 } }))
  await hostDialog.getByLabel('SSH 地址').fill('10.0.0.8')
  await hostDialog.getByLabel('SSH 用户').fill('e2e')
  await hostDialog.getByLabel('私钥', { exact: true }).fill('e2e-private-key')
  await hostDialog.getByRole('button', { name: '测试连接' }).click()
  await expect(hostDialog.getByText('连接验证通过')).toBeVisible()
  await expect(hostDialog.getByRole('button', { name: /保\s*存/ })).toBeEnabled()
  await expect(hostDialog.getByLabel('托管数据根目录')).not.toBeVisible()
  await hostDialog.getByText('高级设置', { exact: true }).click()
  await expect(hostDialog.getByLabel('托管数据根目录')).toHaveValue('/opt/dbmock')
  await hostDialog.getByLabel('托管数据根目录').fill('/srv/dbmock')
  await expect(hostDialog.getByText('连接信息已变更，请重新测试。')).toBeVisible()
  await expect(hostDialog.getByRole('button', { name: /保\s*存/ })).toBeDisabled()
  await hostDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.unroute('**/api/v1/hosts/test')

  await page.goto('/projects')
  await expect(page.getByText('尚未创建项目。项目可用于按团队、环境或业务线组织主机和数据库。')).toBeVisible()
  await page.locator('.page-header').getByRole('button', { name: '创建' }).click()
  let projectDialog = page.getByRole('dialog', { name: '创建' })
  await projectDialog.getByLabel('名称').fill('E2E Project')
  await projectDialog.getByLabel('描述').fill('Must not leak into the next project')
  await projectDialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(page.getByRole('heading', { name: 'E2E Project' })).toBeVisible()
  await page.getByRole('button', { name: '编辑 E2E Project' }).click()
  projectDialog = page.getByRole('dialog', { name: '编辑' })
  await expect(projectDialog.getByLabel('描述')).toHaveValue('Must not leak into the next project')
  await projectDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.page-header').getByRole('button', { name: '创建' }).click()
  projectDialog = page.getByRole('dialog', { name: '创建' })
  await expect(projectDialog.getByLabel('名称')).toHaveValue('')
  await expect(projectDialog.getByLabel('描述')).toHaveValue('')
  await projectDialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.goto('/instances')
  await expect(page.getByText('尚未创建数据库。接入可用主机后，即可从目录选择模板部署。')).toBeVisible()
  await expect(page.locator('.page-header').getByRole('button', { name: '接入主机' })).toBeVisible()
  await page.route('**/api/v1/hosts', async (route) => route.fulfill({ json: { items: [{ id: '11111111-1111-4111-8111-111111111111', name: 'E2E Host', status: 'online', architecture: 'arm64', cpuCount: 8, memoryBytes: 17179869184, diskFreeBytes: 85899345920, portStart: 20000, portEnd: 40000 }] } }))
  await page.goto('/instances?create=1')
  const createInstanceDrawer = page.getByRole('dialog', { name: '创建数据库' })
  await expect(createInstanceDrawer).toBeVisible()
  await expect(createInstanceDrawer.getByRole('button', { name: '上一步' })).toBeDisabled()
  await expect(createInstanceDrawer.getByRole('button', { name: '下一步' })).toBeVisible()
  const templateSelect = createInstanceDrawer.getByLabel('模板 / 版本')
  await templateSelect.click()
  await templateSelect.press('ArrowDown')
  await templateSelect.press('Enter')
  await createInstanceDrawer.getByRole('button', { name: '下一步' }).click()
  await createInstanceDrawer.getByLabel('名称').fill('E2E Database')
  await createInstanceDrawer.getByRole('button', { name: '下一步' }).click()
  const requestedCPU = createInstanceDrawer.getByLabel('CPU')
  await expect(requestedCPU).not.toHaveValue('')
  await expect(createInstanceDrawer.getByText('1 / 1 台兼容主机可承载当前资源')).toBeVisible()
  await requestedCPU.fill('100')
  await expect(createInstanceDrawer.getByText('当前资源或端口没有可用主机')).toBeVisible()
  await expect(createInstanceDrawer.getByRole('button', { name: '下一步' })).toBeDisabled()
  await requestedCPU.fill('2')
  await expect(createInstanceDrawer.getByText('1 / 1 台兼容主机可承载当前资源')).toBeVisible()
  const requestedPort = createInstanceDrawer.getByLabel('端口 (可选)')
  await requestedPort.fill('50000')
  await expect(createInstanceDrawer.getByText('当前资源或端口没有可用主机')).toBeVisible()
  await expect(createInstanceDrawer.getByRole('button', { name: '下一步' })).toBeDisabled()
  await requestedPort.fill('')
  await expect(createInstanceDrawer.getByText('1 / 1 台兼容主机可承载当前资源')).toBeVisible()
  await createInstanceDrawer.getByRole('button', { name: '下一步' }).click()
  await createInstanceDrawer.getByLabel('额外环境变量（JSON）').fill('[]')
  await createInstanceDrawer.getByRole('button', { name: '下一步' }).click()
  await expect(createInstanceDrawer.getByText('请输入合法的 JSON 对象，例如 {"TZ":"Asia/Shanghai"}')).toBeVisible()
  await createInstanceDrawer.getByLabel('额外环境变量（JSON）').fill('{"TZ":"Asia/Shanghai"}')
  await createInstanceDrawer.getByRole('button', { name: '下一步' }).click()
  await expect(createInstanceDrawer.getByText('创建实例会启动持久化任务。你可以安全离开本页，并在任务中心跟踪进度。')).toBeVisible()
  await expect(createInstanceDrawer.getByRole('button', { name: '上一步' })).toBeEnabled()
  await createInstanceDrawer.getByRole('button', { name: '上一步' }).click()
  await expect(createInstanceDrawer.getByLabel('额外环境变量（JSON）')).toHaveValue('{"TZ":"Asia/Shanghai"}')
  await createInstanceDrawer.getByRole('button', { name: /取\s*消/ }).click()
  await page.unroute('**/api/v1/hosts')

  const instanceID = '44444444-4444-4444-8444-444444444444'
  let failLogs = true
  let instanceStatus = 'running'
  let relatedTasks: Array<Record<string, unknown>> = []
  await page.route(`**/api/v1/instances/${instanceID}`, async (route) => route.fulfill({ json: {
    id: instanceID, name: 'Orders DB', hostId: '11111111-1111-4111-8111-111111111111', templateVersionId: '55555555-5555-4555-8555-555555555555',
    projectId: '77777777-7777-4777-8777-777777777777', environment: 'development', labels: { team: 'checkout' }, status: instanceStatus, desiredState: 'running', autoRestart: true, restartFailures: 0,
    cpu: 2, memoryBytes: 4294967296, reservedDiskBytes: 21474836480, hostPort: 25432, containerPort: 5432, bindAddress: '0.0.0.0',
    databaseUsername: 'app', databaseName: 'orders', templateSlug: 'postgresql', templateName: 'PostgreSQL', templateVersion: '17',
    hostName: 'E2E Host', connectionAddress: '10.0.0.8', createdAt: new Date().toISOString(), lastHealthyAt: new Date().toISOString(),
  } }))
  await page.route('**/api/v1/tasks?resourceType=instance&resourceId=**', async (route) => route.fulfill({ json: { items: relatedTasks } }))
  await page.route('**/api/v1/tasks/66666666-6666-4666-8666-666666666666/retry', async (route) => {
    const retried = { ...relatedTasks[0], id: '88888888-8888-4888-8888-888888888888', status: 'queued', progress: 0, stage: 'queued', message: 'task_started' }
    relatedTasks = [retried]
    await route.fulfill({ status: 202, json: retried })
  })
  await page.route(`**/api/v1/instances/${instanceID}/connection`, async (route) => route.fulfill({ json: { address: '10.0.0.8', port: 25432, username: 'app', password: 'e2e-secret', database: 'orders', uri: 'postgresql://app:e2e-secret@10.0.0.8:25432/orders', jdbc: 'jdbc:postgresql://10.0.0.8:25432/orders' } }))
  await page.route(`**/api/v1/instances/${instanceID}/logs?**`, async (route) => failLogs
    ? route.fulfill({ status: 503, json: { error: { code: 'resource_unavailable', message: 'resource temporarily unavailable: unable to reach the instance host over SSH' } } })
    : route.fulfill({ status: 200, contentType: 'text/plain', body: '' }))
  await page.route(`**/api/v1/instances/${instanceID}/metrics?**`, async (route) => route.fulfill({ json: { items: [
    { collectedAt: new Date(Date.now() - 60000).toISOString(), cpuPercent: 12.5, memoryBytes: 2147483648, memoryPercent: 50, diskUsedBytes: 5368709120, diskTotalBytes: 21474836480 },
    { collectedAt: new Date().toISOString(), cpuPercent: 17.5, memoryBytes: 2362232012, memoryPercent: 55, diskUsedBytes: 6442450944, diskTotalBytes: 21474836480 },
  ] } }))
  await page.goto(`/instances/${instanceID}`)
  await expect(page.getByRole('heading', { name: /Orders DB/ })).toBeVisible()
  await expect(page.getByText('实例正在运行，暂未发现健康问题。')).toBeVisible()
  await expect(page.getByText('100%', { exact: true })).toHaveCount(0)
  await expect(page.getByText('team=checkout', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '更多操作' }).click()
  await expect(page.getByRole('menuitem', { name: '升级' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible()
  await page.keyboard.press('Escape')

  instanceStatus = 'provisioning'
  relatedTasks = [{ id: '99999999-9999-4999-8999-999999999999', kind: 'instance.create', status: 'running', resourceType: 'instance', resourceId: instanceID, progress: 42, stage: 'image', message: 'preparing_database_image', cancelable: true, cancelAsked: false, attempts: 1, createdAt: new Date().toISOString() }]
  await page.reload()
  await expect(page.getByText('42%', { exact: true })).toBeVisible()
  await expect(page.getByText('正在准备数据库镜像')).toBeVisible()
  await expect(page.getByRole('button', { name: '查看任务' })).toBeVisible()

  instanceStatus = 'failed'
  relatedTasks = [{ id: '66666666-6666-4666-8666-666666666666', kind: 'instance.create', status: 'failed', resourceType: 'instance', resourceId: instanceID, progress: 42, stage: 'image', message: 'preparing_database_image', errorCode: 'ssh_timeout', errorMessage: 'ssh connection timed out', cancelable: false, cancelAsked: false, attempts: 1, createdAt: new Date().toISOString() }]
  await page.reload()
  await expect(page.getByText('SSH 连接超时')).toBeVisible()
  await page.getByRole('button', { name: '重试任务' }).click()
  await expect(page.getByText('排队中', { exact: true })).toBeVisible()

  instanceStatus = 'running'
  relatedTasks = []
  await page.reload()

  await page.getByRole('tab', { name: '连接信息' }).click()
  await expect(page.getByText('连接信息受保护')).toBeVisible()
  await page.getByRole('button', { name: '显示连接信息' }).click()
  await expect(page.getByText('e2e-secret', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '复制环境变量' }).click()
  await expect(page.getByText('环境变量已复制')).toBeVisible()
  await page.getByRole('button', { name: '隐藏连接信息' }).click()
  await expect(page.getByText('e2e-secret', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '显示连接信息' }).click()

  await page.getByRole('tab', { name: '日志' }).click()
  await expect(page).toHaveURL(new RegExp(`${instanceID}\\?tab=logs$`))
  await expect(page.getByText('无法加载实例日志')).toBeVisible()
  await expect(page.getByText('暂时无法通过 SSH 连接实例主机，请检查主机网络与 SSH 配置')).toBeVisible()
  failLogs = false
  await page.getByRole('button', { name: /重\s*试/ }).click()
  await expect(page.getByText('当前没有可显示的容器日志。实例刚启动时可能需要稍等片刻。')).toBeVisible()
  await page.getByRole('tab', { name: '连接信息' }).click()
  await expect(page.getByText('连接信息受保护')).toBeVisible()

  await page.getByRole('tab', { name: '监控' }).click()
  await expect(page.locator('.metric-stat').filter({ hasText: 'CPU' })).toContainText('17.5%')
  await expect(page.getByText('最近 24 小时', { exact: true })).toBeVisible()
  await page.unroute(`**/api/v1/instances/${instanceID}/metrics?**`)
  await page.unroute(`**/api/v1/instances/${instanceID}/logs?**`)
  await page.unroute(`**/api/v1/instances/${instanceID}/connection`)
  await page.unroute(`**/api/v1/instances/${instanceID}`)
  await page.unroute('**/api/v1/tasks?resourceType=instance&resourceId=**')
  await page.unroute('**/api/v1/tasks/66666666-6666-4666-8666-666666666666/retry')

  await page.goto('/images')
  await expect(page.getByText('尚未上传离线镜像。上传 docker save 导出的镜像包，即可在无法访问镜像仓库时部署数据库。')).toBeVisible()
  await expect(page.getByRole('button', { name: '上传离线镜像' }).first()).toBeVisible()
  await page.getByRole('button', { name: '上传离线镜像' }).first().click()
  const uploadImageDialog = page.getByRole('dialog', { name: '上传离线镜像' })
  await expect(uploadImageDialog.getByText('支持断点续传')).toBeVisible()
  await expect(uploadImageDialog.getByLabel('显示名称')).toHaveValue('')
  await uploadImageDialog.getByLabel(/预期 SHA-256/).fill('invalid')
  await expect(uploadImageDialog.getByText('请输入 64 位十六进制 SHA-256')).toBeVisible()
  await uploadImageDialog.getByRole('button', { name: '关闭', exact: true }).click()

  const imageID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const registryID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let registryName = 'Engineering Harbor'
  let registryStatus = 'unknown'
  let registryStatusMessage = ''
  let registryStatusCode: number | undefined
  let registryLastTestedAt: string | undefined
  const imageCreatedAt = new Date(Date.now() - 86400000).toISOString()
  const registryUpdatedAt = new Date().toISOString()
  await page.route('**/api/v1/images', async (route) => route.fulfill({ json: { items: [{ id: imageID, name: 'PostgreSQL 17 offline', filename: 'postgresql-17.tar.gz', sizeBytes: 125829120, sha256: 'a'.repeat(64), format: 'docker', imageRefs: ['postgres:17.5'], architectures: ['amd64'], status: 'ready', usedByCount: 2, createdAt: imageCreatedAt }] } }))
  await page.route('**/api/v1/registries', async (route) => route.fulfill({ json: { items: [{ id: registryID, name: registryName, url: 'https://harbor.example.test', username: 'robot$dbmock', hasPassword: true, hasCaCertificate: true, status: registryStatus, statusMessage: registryStatusMessage, statusCode: registryStatusCode, lastTestedAt: registryLastTestedAt, createdAt: registryUpdatedAt, updatedAt: registryUpdatedAt }] } }))
  await page.route(`**/api/v1/registries/${registryID}/test`, async (route) => {
    registryStatus = 'online'
    registryStatusMessage = 'registry_reachable'
    registryStatusCode = 200
    registryLastTestedAt = new Date().toISOString()
    await route.fulfill({ json: { status: registryStatus, message: registryStatusMessage, statusCode: registryStatusCode, checkedAt: registryLastTestedAt } })
  })
  await page.route(`**/api/v1/registries/${registryID}`, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON()
      registryName = body.name
      registryStatus = 'unknown'
      registryStatusMessage = ''
      registryStatusCode = undefined
      registryLastTestedAt = undefined
      expect(body.password).toBe('')
      expect(body.caCertificate).toBe('')
      expect(body.clearPassword).toBe(true)
      expect(body.clearCaCertificate).toBe(true)
      await route.fulfill({ json: { id: registryID, ...body, hasPassword: false, hasCaCertificate: false, status: 'unknown', createdAt: registryUpdatedAt, updatedAt: new Date().toISOString() } })
      return
    }
    await route.continue()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'PostgreSQL 17 offline', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'PostgreSQL 17 offline', exact: true }).click()
  const imageDrawer = page.getByRole('dialog', { name: /PostgreSQL 17 offline/ })
  await expect(imageDrawer.getByText('镜像已通过归档检查')).toBeVisible()
  await expect(imageDrawer.getByText('被 2 个数据库实例使用').first()).toBeVisible()
  await expect(imageDrawer.getByRole('button', { name: '删除' })).toBeDisabled()
  await expect(imageDrawer.getByText('a'.repeat(64))).toBeVisible()
  await imageDrawer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('tab', { name: /镜像仓库/ }).click()
  await expect(page.getByText('从控制服务验证仓库')).toBeVisible()
  await page.getByRole('button', { name: '测试连通性' }).click()
  await expect(page.getByText('仓库可访问且认证成功')).toBeVisible()
  await expect(page.getByText('在线', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('仓库可访问且认证成功')).toBeVisible()
  await page.getByRole('button', { name: '编辑' }).click()
  const registryDialog = page.getByRole('dialog', { name: '编辑仓库' })
  await expect(registryDialog.getByLabel('名称')).toHaveValue('Engineering Harbor')
  await expect(registryDialog.getByText('已配置密码；留空将保持现有密码。')).toBeVisible()
  await expect(registryDialog.getByText('已配置自定义 CA；留空将保持现有证书。')).toBeVisible()
  await registryDialog.getByRole('checkbox', { name: '移除已配置的密码' }).check()
  await registryDialog.getByRole('checkbox', { name: '移除已配置的自定义 CA' }).check()
  await registryDialog.getByLabel('名称').fill('Platform Harbor')
  await registryDialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(page.getByRole('heading', { name: 'Platform Harbor' })).toBeVisible()
  await expect(page.getByText('仓库可访问且认证成功')).toBeVisible()
  await page.unroute(`**/api/v1/registries/${registryID}`)
  await page.unroute(`**/api/v1/registries/${registryID}/test`)
  await page.unroute('**/api/v1/registries')
  await page.unroute('**/api/v1/images')

  await page.goto('/catalog')
  await expect(page.locator('.database-icon')).toHaveCount(19)
  await expect(page.getByRole('img', { name: 'MySQL' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'PostgreSQL' })).toBeVisible()
  const cardLayout = await page.evaluate(() => Array.from(document.querySelectorAll('.template-card')).slice(0, 3).map((card) => {
    const rect = card.getBoundingClientRect()
    const offsetTop = (selector: string) => Math.round((card.querySelector(selector)?.getBoundingClientRect().top ?? 0) - rect.top)
    return { width: Math.round(rect.width), baselines: ['.template-card-header', '.template-card-description', '.template-card-tags', '.template-meta', '.ant-card-actions'].map(offsetTop) }
  }))
  expect(cardLayout[0].baselines).toEqual(cardLayout[1].baselines)
  expect(cardLayout[1].baselines).toEqual(cardLayout[2].baselines)
  expect(Math.min(...cardLayout.map(({ width }) => width))).toBeGreaterThanOrEqual(360)
  await page.getByRole('searchbox', { name: '搜索' }).fill('definitely-no-such-database')
  await expect(page.getByText('没有匹配的数据库模板。请调整搜索词或筛选条件。')).toBeVisible()
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(page.locator('.database-icon')).toHaveCount(19)
  await page.locator('.template-card').first().getByRole('button', { name: '创建' }).click()
  const redirectedHostDialog = page.getByRole('dialog', { name: '接入主机' })
  await expect(redirectedHostDialog).toBeVisible()
  await expect(page).toHaveURL(/\/hosts\?returnTo=/)
  const preservedReturn = new URL(page.url()).searchParams.get('returnTo')
  expect(preservedReturn).toMatch(/^\/instances\?create=1&template=/)
  await redirectedHostDialog.getByRole('button', { name: '关闭', exact: true }).click()

  const taskID = '22222222-2222-4222-8222-222222222222'
  const hostUpdatedAt = new Date().toISOString()
  await page.route('**/api/v1/hosts', async (route) => route.fulfill({ json: { items: [{ id: '11111111-1111-4111-8111-111111111111', name: 'E2E Host', status: 'online', sshUser: 'e2e', sshAddress: '10.0.0.8', sshPort: 22, connectionAddress: '10.0.0.8', dataRoot: '/opt/dbmock', portStart: 20000, portEnd: 40000, manageDocker: true, os: 'linux', distro: 'Ubuntu 24.04', architecture: 'amd64', dockerVersion: '27.5.1', composeVersion: '2.35.1', cpuCount: 8, memoryBytes: 17179869184, diskTotalBytes: 107374182400, diskFreeBytes: 85899345920, maintenance: false, autoRestartDefault: true, consecutiveFailures: 0, labels: { team: 'platform' }, lastCheckedAt: hostUpdatedAt, lastSeenAt: hostUpdatedAt, createdAt: hostUpdatedAt, updatedAt: hostUpdatedAt }] } }))
  await page.route('**/api/v1/instances?hostId=**', async (route) => route.fulfill({ json: { items: [{ id: instanceID, name: 'Orders DB', hostId: '11111111-1111-4111-8111-111111111111', templateVersionId: '55555555-5555-4555-8555-555555555555', environment: 'development', labels: {}, status: 'running', desiredState: 'running', autoRestart: true, restartFailures: 0, cpu: 2, memoryBytes: 4294967296, reservedDiskBytes: 21474836480, hostPort: 25432, containerPort: 5432, bindAddress: '0.0.0.0', databaseUsername: 'app', databaseName: 'orders', templateSlug: 'postgresql', templateName: 'PostgreSQL', templateVersion: '17', hostName: 'E2E Host', connectionAddress: '10.0.0.8', createdAt: hostUpdatedAt }] } }))
  await page.route('**/api/v1/tasks?resourceType=host&resourceId=**', async (route) => route.fulfill({ json: { items: [{ id: taskID, kind: 'host_probe', status: 'running', resourceType: 'host', resourceId: '11111111-1111-4111-8111-111111111111', progress: 35, stage: 'probe', message: 'checking_host_and_template', cancelable: true, cancelAsked: false, attempts: 1, createdAt: hostUpdatedAt }] } }))
  await page.route(`**/api/v1/tasks/${taskID}`, async (route) => route.fulfill({ json: { id: taskID, kind: 'host_probe', status: 'running', resourceType: 'host', resourceId: '11111111-1111-4111-8111-111111111111', progress: 35, stage: 'probe', message: 'checking_host_and_template', cancelable: true, cancelAsked: false, attempts: 1, createdAt: new Date().toISOString() } }))
  await page.route(`**/api/v1/tasks/${taskID}/logs`, async (route) => route.fulfill({ json: { items: [] } }))
  await page.route(`**/api/v1/tasks/${taskID}/cancel`, async (route) => route.fulfill({ status: 202, json: { ok: true } }))
  await page.goto(`/tasks?task=${taskID}`)
  let taskDrawer = page.getByRole('dialog', { name: /检测主机.*22222222/ })
  await expect(taskDrawer).toBeVisible()
  await expect(taskDrawer.getByText('任务尚未产生执行记录。')).toBeVisible()
  await taskDrawer.getByRole('button', { name: '取消任务' }).click()
  await expect(page.getByText('任务会在下一个安全检查点停止，已完成的步骤不会回滚。')).toBeVisible()
  await page.getByRole('button', { name: /确\s*认/ }).click()
  await taskDrawer.getByRole('button', { name: '查看对应资源' }).click()
  await expect(page).toHaveURL(/\/hosts\?host=11111111/)
  const linkedHostDialog = page.getByRole('dialog', { name: 'E2E Host' })
  await expect(linkedHostDialog).toBeVisible()
  await expect(linkedHostDialog.getByText('调度容量', { exact: true })).toBeVisible()
  await expect(linkedHostDialog.getByText('Orders DB', { exact: true })).toBeVisible()
  await expect(linkedHostDialog.getByText('35%', { exact: true })).toBeVisible()
  await expect(linkedHostDialog.getByText('team=platform', { exact: true })).toBeVisible()
  await linkedHostDialog.getByRole('button', { name: '编辑' }).click()
  const editHostDialog = page.getByRole('dialog', { name: '编辑' })
  await expect(editHostDialog).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await editHostDialog.getByRole('button', { name: /取\s*消/ }).click()
  await expect(page.getByRole('dialog', { name: 'E2E Host' })).toBeVisible()
  await page.getByRole('dialog', { name: 'E2E Host' }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.unroute('**/api/v1/tasks?resourceType=host&resourceId=**')
  await page.unroute('**/api/v1/instances?hostId=**')
  await page.unroute('**/api/v1/hosts')
  await page.unroute(`**/api/v1/tasks/${taskID}/cancel`)
  await page.unroute(`**/api/v1/tasks/${taskID}`)
  await page.unroute(`**/api/v1/tasks/${taskID}/logs`)

  const failedTaskID = '33333333-3333-4333-8333-333333333333'
  const retriedTaskID = '33333333-3333-4333-8333-333333333334'
  const failedTask = { id: failedTaskID, kind: 'instance_create', status: 'failed', resourceType: 'instance', resourceId: instanceID, progress: 72, stage: 'compose', message: 'starting_docker_compose_project', errorCode: 'ssh_timeout', errorMessage: 'ssh: connect to host 10.0.0.8 port 22: Connection timed out', cancelable: false, cancelAsked: false, attempts: 1, createdAt: new Date(Date.now() - 600000).toISOString(), startedAt: new Date(Date.now() - 540000).toISOString(), finishedAt: new Date(Date.now() - 300000).toISOString() }
  const retriedTask = { ...failedTask, id: retriedTaskID, status: 'queued', progress: 0, stage: 'queued', message: '', errorCode: '', errorMessage: '', attempts: 0, startedAt: undefined, finishedAt: undefined, createdAt: new Date().toISOString() }
  await page.route(`**/api/v1/tasks/${failedTaskID}`, async (route) => route.fulfill({ json: failedTask }))
  await page.route(`**/api/v1/tasks/${failedTaskID}/logs`, async (route) => route.fulfill({ json: { items: [{ id: 1, level: 'error', message: 'ssh_connection_timed_out', createdAt: failedTask.finishedAt }] } }))
  await page.route(`**/api/v1/tasks/${failedTaskID}/retry`, async (route) => route.fulfill({ status: 202, json: retriedTask }))
  await page.route(`**/api/v1/tasks/${retriedTaskID}`, async (route) => route.fulfill({ json: retriedTask }))
  await page.route(`**/api/v1/tasks/${retriedTaskID}/logs`, async (route) => route.fulfill({ json: { items: [] } }))
  await page.goto(`/tasks?task=${failedTaskID}`)
  taskDrawer = page.getByRole('dialog', { name: /创建数据库实例.*33333333/ })
  await expect(taskDrawer.getByText('在「Compose」阶段失败')).toBeVisible()
  await expect(taskDrawer.getByText('SSH 连接超时').first()).toBeVisible()
  await expect(taskDrawer.getByText(/Connection timed out/)).toBeVisible()
  await expect(taskDrawer.getByRole('button', { name: '查看对应资源' })).toBeVisible()
  await taskDrawer.getByRole('button', { name: '重试任务' }).click()
  await expect(page).toHaveURL(new RegExp(`task=${retriedTaskID}`))
  await expect(page.getByRole('dialog', { name: /创建数据库实例.*33333333/ }).getByText('排队中')).toBeVisible()
  await page.getByRole('dialog', { name: /创建数据库实例.*33333333/ }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.unroute(`**/api/v1/tasks/${retriedTaskID}/logs`)
  await page.unroute(`**/api/v1/tasks/${retriedTaskID}`)
  await page.unroute(`**/api/v1/tasks/${failedTaskID}/retry`)
  await page.unroute(`**/api/v1/tasks/${failedTaskID}/logs`)
  await page.unroute(`**/api/v1/tasks/${failedTaskID}`)

  const alertID = '66666666-6666-4666-8666-666666666666'
  const webhookID = '77777777-7777-4777-8777-777777777777'
  const failedDeliveryID = '88888888-8888-4888-8888-888888888888'
  const testDeliveryID = '88888888-8888-4888-8888-888888888889'
  const alertHost = { id: '11111111-1111-4111-8111-111111111111', name: 'E2E Host', status: 'offline', sshUser: 'e2e', sshAddress: '10.0.0.8', sshPort: 22, connectionAddress: '10.0.0.8', dataRoot: '/opt/dbmock', portStart: 20000, portEnd: 40000, manageDocker: false, cpuCount: 8, memoryBytes: 17179869184, diskTotalBytes: 107374182400, diskFreeBytes: 85899345920, maintenance: false, autoRestartDefault: true }
  let alertStatus = 'open'
  let alertAcknowledgedAt: string | undefined
  let alertAcknowledgedBy: string | undefined
  let alertResolvedAt: string | undefined
  let alertResolvedBy: string | undefined
  let webhookHasSecret = true
  let retriedDelivery = false
  let testQueued = false
  let deliveryPolls = 0
  await page.route('**/api/v1/alerts', async (route) => route.fulfill({ json: { items: [{ id: alertID, severity: 'critical', type: 'host_offline', resourceType: 'host', resourceId: alertHost.id, title: 'Host is offline', message: 'ssh: connect to host 10.0.0.8 port 22: Connection timed out', status: alertStatus, createdAt: new Date(Date.now() - 300000).toISOString(), acknowledgedAt: alertAcknowledgedAt, acknowledgedBy: alertAcknowledgedBy, resolvedAt: alertResolvedAt, resolvedBy: alertResolvedBy }] } }))
  await page.route(`**/api/v1/alerts/${alertID}/acknowledged`, async (route) => { alertStatus = 'acknowledged'; alertAcknowledgedAt = new Date().toISOString(); alertAcknowledgedBy = 'e2e-admin'; await route.fulfill({ json: { ok: true } }) })
  await page.route(`**/api/v1/alerts/${alertID}/resolved`, async (route) => { alertStatus = 'resolved'; alertResolvedAt = new Date().toISOString(); alertResolvedBy = 'e2e-admin'; await route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/v1/hosts', async (route) => route.fulfill({ json: { items: [alertHost] } }))
  await page.route('**/api/v1/instances', async (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/webhooks', async (route) => route.fulfill({ json: { items: [{ id: webhookID, name: 'Engineering alerts', url: 'https://hooks.example.test/dbmock', hasSecret: webhookHasSecret, events: ['alert.created', 'task.failed'], enabled: true, lastDeliveryStatus: 'failed', lastDeliveryAt: new Date().toISOString(), failedDeliveries: 1, queuedDeliveries: 0, createdAt: new Date(Date.now() - 86400000).toISOString(), updatedAt: new Date().toISOString() }] } }))
  await page.route(`**/api/v1/webhooks/${webhookID}`, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON()
      expect(body.events).toEqual(['*'])
      if (body.clearSecret) webhookHasSecret = false
      await route.fulfill({ json: { id: webhookID, ...body, hasSecret: webhookHasSecret } })
      return
    }
    await route.fulfill({ json: { id: webhookID } })
  })
  await page.route(`**/api/v1/webhooks/${webhookID}/test`, async (route) => { testQueued = true; await route.fulfill({ status: 202, json: { queued: true, deliveryId: testDeliveryID } }) })
  await page.route(`**/api/v1/webhooks/${webhookID}/deliveries`, async (route) => {
    deliveryPolls += 1
    const now = new Date().toISOString()
    const items = [{ id: failedDeliveryID, webhookId: webhookID, eventId: '99999999-9999-4999-8999-999999999999', eventType: 'task.failed', status: retriedDelivery ? 'pending' : 'failed', attempts: retriedDelivery ? 0 : 5, nextAttemptAt: now, responseStatus: retriedDelivery ? undefined : 503, responseBody: retriedDelivery ? '' : 'temporarily unavailable', errorMessage: retriedDelivery ? '' : 'webhook returned HTTP 503', createdAt: new Date(Date.now() - 600000).toISOString(), updatedAt: now }]
    if (testQueued) items.unshift({ id: testDeliveryID, webhookId: webhookID, eventId: '99999999-9999-4999-8999-999999999998', eventType: 'webhook.test', status: deliveryPolls > 2 ? 'delivered' : 'pending', attempts: deliveryPolls > 2 ? 1 : 0, nextAttemptAt: now, responseStatus: deliveryPolls > 2 ? 204 : undefined, responseBody: '', errorMessage: '', createdAt: now, updatedAt: now })
    await route.fulfill({ json: { items } })
  })
  await page.route(`**/api/v1/webhooks/${webhookID}/deliveries/${failedDeliveryID}/retry`, async (route) => { retriedDelivery = true; await route.fulfill({ status: 202, json: { queued: true } }) })

  await page.goto('/alerts')
  await expect(page.getByRole('button', { name: '主机已离线' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'E2E Host' })).toBeVisible()
  await expect(page.locator('.ant-badge-count')).toContainText('1')
  await page.getByRole('button', { name: '主机已离线' }).click()
  let alertDrawer = page.getByRole('dialog', { name: '告警详情' })
  await expect(alertDrawer.getByText('平台无法通过 SSH 连接主机。')).toBeVisible()
  await expect(alertDrawer.getByText(/Connection timed out/)).toBeVisible()
  await alertDrawer.getByRole('button', { name: '确认告警' }).click()
  await expect(alertDrawer.getByText('已确认')).toBeVisible()
  await expect(alertDrawer.getByText('e2e-admin')).toBeVisible()
  await alertDrawer.getByRole('button', { name: '查看对应资源' }).click()
  await expect(page).toHaveURL(/\/hosts\?host=11111111/)
  const alertHostDialog = page.getByRole('dialog', { name: 'E2E Host' })
  await expect(alertHostDialog).toBeVisible()
  await alertHostDialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.goto('/alerts?tab=webhooks')
  await expect(page.getByRole('heading', { name: 'Engineering alerts' })).toBeVisible()
  await expect(page.getByText('新告警')).toBeVisible()
  await expect(page.getByText('1 条失败投递')).toBeVisible()
  await page.getByRole('button', { name: '编辑' }).click()
  const webhookDialog = page.getByRole('dialog', { name: '编辑 Webhook' })
  await expect(webhookDialog.getByLabel('名称')).toHaveValue('Engineering alerts')
  await expect(webhookDialog.getByText('已配置签名密钥；留空将保持现有密钥不变。')).toBeVisible()
  await webhookDialog.getByRole('combobox', { name: '订阅事件' }).click()
  const allEventsOption = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: '全部事件' })
  await expect(allEventsOption).toBeVisible()
  await allEventsOption.click()
  await page.keyboard.press('Escape')
  await expect(allEventsOption).toBeHidden()
  await webhookDialog.getByRole('checkbox', { name: '移除已配置的 HMAC 密钥' }).check()
  await expect(webhookDialog.getByRole('textbox', { name: 'HMAC 密钥' })).toBeDisabled()
  await webhookDialog.getByRole('button', { name: /保\s*存/ }).click()
  await expect(page.getByText('HMAC 签名已开启')).toHaveCount(0)
  await page.getByRole('button', { name: '投递记录' }).click()
  let deliveryDrawer = page.getByRole('dialog', { name: /投递记录.*Engineering alerts/ })
  await expect(deliveryDrawer.getByText('503')).toBeVisible()
  await deliveryDrawer.getByRole('button', { name: '重新投递' }).click()
  await expect(deliveryDrawer.getByText('等待中')).toBeVisible()
  await deliveryDrawer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.webhook-card').getByRole('button', { name: '测试 Webhook' }).click()
  deliveryDrawer = page.getByRole('dialog', { name: /投递记录.*Engineering alerts/ })
  await expect(deliveryDrawer.getByText('测试请求')).toBeVisible()
  await expect(deliveryDrawer.getByText('已送达')).toBeVisible({ timeout: 10000 })
  await deliveryDrawer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.unroute(`**/api/v1/webhooks/${webhookID}/deliveries/${failedDeliveryID}/retry`)
  await page.unroute(`**/api/v1/webhooks/${webhookID}/deliveries`)
  await page.unroute(`**/api/v1/webhooks/${webhookID}/test`)
  await page.unroute(`**/api/v1/webhooks/${webhookID}`)
  await page.unroute('**/api/v1/webhooks')
  await page.unroute('**/api/v1/instances')
  await page.unroute('**/api/v1/hosts')
  await page.unroute(`**/api/v1/alerts/${alertID}/resolved`)
  await page.unroute(`**/api/v1/alerts/${alertID}/acknowledged`)
  await page.unroute('**/api/v1/alerts')

  await page.goto('/audit')
  await page.locator('.page-header').getByRole('button', { name: '清理' }).click()
  let clearAuditDialog = page.getByRole('dialog', { name: '清理' })
  await clearAuditDialog.getByLabel('输入 CLEAR 以确认').fill('CLEAR')
  await expect(clearAuditDialog.getByRole('button', { name: /确\s*定/ })).toBeEnabled()
  await clearAuditDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.page-header').getByRole('button', { name: '清理' }).click()
  clearAuditDialog = page.getByRole('dialog', { name: '清理' })
  await expect(clearAuditDialog.getByLabel('输入 CLEAR 以确认')).toHaveValue('')
  await expect(clearAuditDialog.getByRole('button', { name: /确\s*定/ })).toBeDisabled()
  await clearAuditDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto('/')

  await page.goto('/users')
  await page.getByRole('button', { name: '编辑 E2E Admin' }).click()
  const currentUserDialog = page.getByRole('dialog', { name: '编辑' })
  await expect(currentUserDialog.getByText('当前登录账号不能禁用；如需停用，请先使用其他账号登录。')).toBeVisible()
  await expect(currentUserDialog.getByRole('switch', { name: '已禁用' })).toBeDisabled()
  await currentUserDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto('/')

  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.getByText('Dashboard', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Complete your first database deployment', { exact: true })).toBeVisible()
  await expect(page.locator('.page-header').getByRole('button', { name: 'Add host' })).toBeVisible()
  await page.goto('/hosts')
  await expect(page.getByText('Direct SSH only. Linux can optionally install Docker; macOS requires Docker Desktop.')).toBeVisible()

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#password').fill('e2e-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Dashboard', { exact: true }).first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')

  await page.getByRole('button', { name: 'Chinese (Simplified)' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByText('主机', { exact: true }).first()).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByText('主机', { exact: true }).first()).toBeVisible()
  const health = await page.request.get('/api/v1/health')
  expect(health.ok()).toBeTruthy()
})
