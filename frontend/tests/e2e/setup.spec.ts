import { expect, test } from '@playwright/test'

test('initializes the platform and loads the embedded dashboard', async ({ page }) => {
  await page.goto('/')
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#displayName').fill('E2E Admin')
  await page.locator('#password').fill('e2e-password')
  await page.getByRole('button', { name: '初始化 DB Mock' }).click()
  await expect(page.getByText('总览', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '创建数据库' })).toBeVisible()
  const health = await page.request.get('/api/v1/health')
  expect(health.ok()).toBeTruthy()
})
