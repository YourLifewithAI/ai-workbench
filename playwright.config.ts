import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  timeout: 60000,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    // A pinned Chromium (e.g. the one preinstalled in a sandbox) can be pointed at with WB_CHROME; CI installs the matching build.
    ...(process.env['WB_CHROME'] ? { launchOptions: { executablePath: process.env['WB_CHROME'] } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
