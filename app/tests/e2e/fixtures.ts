import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { test as base, expect, type WorkerFixture } from '@playwright/test';

/**
 * TASK-70 e2e fixture: boots the REAL app + server as a child process
 * (npm run dev:test → scripts/dev-test.mjs) on random free ports with a
 * throwaway sqlite DB in a fresh tmp dir, waits for /api/health, and tears
 * the whole process tree down after the test file (worker scope).
 *
 * No pre-started `npm run dev` needed: every file is fully isolated.
 */

const appDir = path.resolve(__dirname, '..', '..');
const BOOT_TIMEOUT_MS = 40_000;
const KILL_TIMEOUT_MS = 8_000;

/** Last lines of the harness output, attached to boot-failure errors. */
function tail(out: string): string {
  return out.slice(-4000);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the vite origin (proxy → API server) until it answers 200 on /api/health. */
async function waitReady(baseURL: string, alive: () => boolean): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!alive()) throw new Error(`dev harness exited before becoming ready:\n${tail(lastLines)}`);
    try {
      const res = await fetch(`${baseURL}/api/health`);
      if (res.status === 200) return;
    } catch {
      // vite or the proxy is not up yet
    }
    if (Date.now() - t0 > BOOT_TIMEOUT_MS) {
      throw new Error(`dev harness not ready in ${BOOT_TIMEOUT_MS} ms:\n${tail(lastLines)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface E2eServer {
  /** Vite origin the browser pages use (proxies /api + /ws to the server). */
  baseURL: string;
  /** Direct API/WS port (REST + ws without the proxy). */
  apiPort: number;
}

let lastLines = '';

interface E2eFixtures {
  e2eServer: E2eServer;
}

// Playwright's runtime requires the first fixture arg to be an object
// destructuring pattern, so the empty {} is mandatory (no fixtures needed).
// eslint-disable-next-line no-empty-pattern
const bootServer: WorkerFixture<E2eServer, E2eFixtures> = async ({}, use) => {
  const vitePort = await freePort();
  const apiPort = await freePort();
  // Fresh tmp dir per test file: sqlite state can never collide across runs.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-e2e-'));
  const child = spawn('npm', ['run', 'dev:test'], {
    cwd: appDir,
    // detached → child is its own process-group leader, so teardown can
    // signal the WHOLE tree (npm → dev-test.mjs → vite + tsx server).
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_PORT: String(vitePort),
      API_PORT: String(apiPort),
      DB_DRIVER: 'sqlite',
      DATABASE_URL: '',
      DB_PATH: path.join(tmpDir, 'drift.db'),
      // e2e runs must be fast and hermetic: 1 system, short flush window.
      SYSTEM_INSTANCE_COUNT: '1',
      SHARD_FLUSH_INTERVAL_MS: '500',
    },
  });
  lastLines = '';
  child.stdout.on('data', (c) => (lastLines += c.toString()));
  child.stderr.on('data', (c) => (lastLines += c.toString()));
  const pid = child.pid;

  const baseURL = `http://127.0.0.1:${vitePort}`;
  await waitReady(baseURL, () => child.exitCode === null && pid !== undefined);

  try {
    await use({ baseURL, apiPort });
  } finally {
    await killTree(child, pid);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

export const test = base.extend<object, E2eFixtures>({
  e2eServer: [bootServer, { scope: 'worker' }],
});

/** SIGTERM the process group, wait KILL_TIMEOUT_MS, then SIGKILL. */
async function killTree(child: ChildProcess, pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  signal('SIGTERM');
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) return;
    if (Date.now() - t0 > KILL_TIMEOUT_MS) {
      signal('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export { expect };
