import { defineConfig, devices } from "@playwright/test";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  globalTimeout: 5 * 60 * 1000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    viewport: { width: 1366, height: 768 },
  },

  // Reuse an externally started `npm run dev` (so the same Vite + Fastify
  // servers persist across iterations and we don't double-bind ports).
  // Set PLAYWRIGHT_START_SERVER=1 to let Playwright manage the lifecycle.
  webServer: process.env.PLAYWRIGHT_START_SERVER
    ? {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
      }
    : undefined,

  // NB: only chromium will run in Docker (arm64).
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The shipped `@playwright/test` 1.62.1 looks for revision 1234 but
        // only 1247/1248 chromium binaries are pre-installed in this
        // sandbox; point the launcher at whichever exists.
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_PATH ||
            "/opt/ms-playwright/chromium-1248/chrome-linux64/chrome",
        },
      },
    },
  ],
});
