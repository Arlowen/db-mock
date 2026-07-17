import { expect, test } from '@playwright/test'

test('initializes the platform and switches the embedded interface language', async ({ page }) => {
  await page.goto('/')
  await page.locator('#username').fill('e2e-admin')
  await page.locator('#displayName').fill('E2E Admin')
  await page.locator('#password').fill('e2e-password')
  await page.getByRole('button', { name: '初始化 DB Mock' }).click()
  await expect(page.getByText('总览', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '创建数据库' })).toBeVisible()

  await page.goto('/catalog')
  await expect(page.locator('.database-icon')).toHaveCount(19)
  await expect(page.getByRole('img', { name: 'MySQL' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'PostgreSQL' })).toBeVisible()
  const cardBaselines = await page.evaluate(() => Array.from(document.querySelectorAll('.template-card')).slice(0, 2).map((card) => {
    const top = (selector: string) => Math.round(card.querySelector(selector)?.getBoundingClientRect().top ?? 0)
    return ['.template-card-title-row', '.template-card-description', '.template-card-tags', '.template-meta', '.ant-card-actions'].map(top)
  }))
  expect(cardBaselines[0]).toEqual(cardBaselines[1])
  await page.goto('/')

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
