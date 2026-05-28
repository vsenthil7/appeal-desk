import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Appeal-Desk web-view e2e tests.
 *
 * Boots `test-e2e/mock-host.cjs` (serves the real client/ assets + stubbed
 * /api/* endpoints) and points the browser at it. Chromium only — that's the
 * engine Reddit's web view host uses.
 */
const PORT = 7331;

export default defineConfig({
  testDir: './test-e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node test-e2e/mock-host.cjs ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
