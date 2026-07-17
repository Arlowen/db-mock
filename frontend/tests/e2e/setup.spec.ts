import { expect, test } from '@playwright/test'

test('initializes the platform and switches the embedded interface language', async ({ page }) => {
  await page.goto('/')
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#displayName').fill('E2E Admin')
  await page.locator('#password').fill('e2e-password')
  await page.getByRole('button', { name: '初始化 DB Mock' }).click()
  await expect(page.getByText('总览', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '创建数据库' })).toBeVisible()

  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.getByText('Dashboard', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create database' })).toBeVisible()
  await page.goto('/hosts')
  await expect(page.getByText('Direct SSH only. Linux can optionally install Docker; macOS requires Docker Desktop.')).toBeVisible()

  await page.getByRole('button', { name: '简体中文' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByText('主机', { exact: true }).first()).toBeVisible()
  const health = await page.request.get('/api/v1/health')
  expect(health.ok()).toBeTruthy()
})
