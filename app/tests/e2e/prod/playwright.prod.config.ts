/**
 * TASK-77 — Playwright config for the production-build gate.
 *
 * Lives next to `tests/e2e/playwright.config.ts` (the dev suite)
 * and ships only the prod gate spec. The fixture in `fixtures.ts`
 * spawns the production server itself, so this config does NOT
 * define a `webServer`.
 *
 * Why a separate config?
 *   - `npm run test:e2e` should NOT run the prod gate. The
 *     Docker-image build is a CI-only check (the gate rebuilds
 *     the client + server, takes ~30-90 s extra). Keeping the
 *     gate under its own config + npm script means a developer
 *     running `npm run test:e2e` is never surprised by it.
 *   - The chromium executable path override has to match the
 *     dev config so headless WebGL behaves identically across
 *     both gates (the same chromium-1248 binary).
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["prod-play.spec.ts"],
  // The fixture mirrors the dev fixture's per-worker boot so the
  // gate is one spec file → one worker → one server.
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
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_PATH ||
            "/opt/ms-playwright/chromium-1248/chrome-linux64/chrome",
        },
      },
    },
  ],
});
