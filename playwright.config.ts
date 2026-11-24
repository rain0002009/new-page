import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/unit/**', '**/fixtures/**'],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: process.env.CI ? 2 : 3,
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', actionTimeout: 8000 },
})

