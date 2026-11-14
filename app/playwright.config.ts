import { defineConfig, devices } from '@playwright/test';
import { loadEndpointConfig } from './src/server/config.ts';
import { findAppDir, loadAppEnv } from './src/server/env.ts';
import { resolveChromiumFromSystem } from './tests/support/chromium.ts';

const { port } = loadEndpointConfig(loadAppEnv(findAppDir(import.meta.dirname)));
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: resolveChromiumFromSystem() },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: `${origin}/api/health`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    // Hermetic: e2e never needs the real SESSION_SECRET from .env.local.
    env: { SESSION_SECRET: 'e2e-only-session-secret-not-a-real-secret' },
  },
});
