import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  // Node (vitest) specs living next to the e2e specs — not Playwright tests.
  // The TASK-70 self-contained harness (tests/e2e/) boots its own server via
  // fixtures.ts and runs under playwright.e2e.config.ts only.
  testIgnore: ['**/validation-fuzz.spec.ts', '**/session-log-leak.spec.ts', 'tests/e2e/**'],
  fullyParallel: true,
  globalTimeout: 30 * 60 * 1000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 3 : 6,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    viewport: { width: 1366, height: 768 },
  },

  // NB: only chromium will run in Docker (arm64).
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
