import { defineConfig, devices } from '@playwright/test';

/**
 * TASK-70: self-contained e2e harness.
 *
 * Each test file boots its OWN real dev server — app + API/WS on random free
 * ports, sqlite DB in a fresh tmp dir — via tests/e2e/fixtures.ts
 * (`npm run dev:test` → scripts/dev-test.mjs). No pre-started `npm run dev`
 * is required, and runs are fully isolated. Run: `npm run test:e2e`.
 * (The legacy specs in tests/ still target a live server on :3000 via
 * playwright.config.ts and are excluded from this config.)
 *
 * WebGL headless: default Chromium (SwiftShader software GL) renders the
 * starfield fine here with NO extra launch flags — verified by the
 * readPixels variance check in core-flow.spec.ts. If an environment's
 * default GL backend produces a black canvas, launch with:
 *
 *   launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] }
 *
 * and record that here.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Single worker + per-file dev-server boots: 13 specs ≈ 2–3 min in this
  // environment (SwiftShader software GL + a fresh vite/tsx per spec).
  globalTimeout: 5 * 60 * 1000,
  // 30 s per test: the two-context specs run two full claim → join → WebGL
  // boots back-to-back and stretch beyond the original 20 s budget as the
  // suite's load accumulates (each spec passes well under this in isolation).
  timeout: 30_000,
  // One worker: the whole suite shares the single fixture server.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      headless: true,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
