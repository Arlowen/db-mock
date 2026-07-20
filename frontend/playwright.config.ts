import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // The full-flow test initializes persistent application state and cannot be replayed safely.
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: process.env.DBMOCK_E2E_URL || 'http://127.0.0.1:8080', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
