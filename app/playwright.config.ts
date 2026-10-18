import { defineConfig, devices } from "@playwright/test";

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * The TASK-70 fixture (`tests/e2e/fixtures.ts`) spawns the dev
 * server per worker with a random free port + tmp sqlite DB, so
 * the suite is fully self-contained: `npm run test:e2e` runs
 * without any external `npm run dev` already running.
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
    // The fixture overrides `baseURL` per worker — tests use
    // `server.baseURL` / `server.apiURL` directly. This default
    // is kept so an old test that still calls `page.goto("/")`
    // gets a sane URL (it'll fail to connect, which is loud
    // enough to surface as a regression).
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    viewport: { width: 1366, height: 768 },
  },

  // The fixture spawns its own dev server — no `webServer` block
  // here, otherwise Playwright would try to bind :3000 and fail.

  // NB: only chromium will run in Docker (arm64).
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The shipped `@playwright/test` 1.62.1 looks for revision
        // 1234 but only 1247/1248 chromium binaries are
        // pre-installed in this sandbox; point the launcher at
        // whichever exists.
        //
        // Headless WebGL works out of the box on chromium-1248 —
        // the canvas comes back with a real WebGL2 context and
        // the starfield renders. If a future sandbox needs GL
        // flags, add `args: ["--use-gl=angle",
        // "--use-angle=swiftshader"]` here.
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_PATH ||
            "/opt/ms-playwright/chromium-1248/chrome-linux64/chrome",
        },
      },
    },
  ],
});