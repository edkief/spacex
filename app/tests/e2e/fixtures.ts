import { test as base, expect, Page, BrowserContext } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ClaimPage } from './pages/claim';

interface GameFixtures {
  gameServer: {
    serverProcess: ChildProcess;
    viteProcess: ChildProcess;
    baseUrl: string;
    wsUrl: string;
  };
  claimPage: (page: Page) => ClaimPage;
}

export const test = base.extend<GameFixtures>({
  gameServer: async ({}, use) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-e2e-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');

    // Find a free port
    const getFreePort = async (): Promise<number> => {
      const net = await import('net');
      return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, () => {
          const port = server.address().port;
          server.close(() => resolve(port));
        });
      });
    };

    const serverPort = await getFreePort();
    const vitePort = await getFreePort();

    const baseUrl = `http://localhost:${vitePort}`;
    const wsUrl = `ws://localhost:${serverPort}/ws`;

    // Start Server
    console.log(`Starting server on port ${serverPort}...`);
    const serverProcess = spawn('node', ['node_modules/.bin/tsx', 'src/server/index.ts'], {
      cwd: path.resolve(__dirname, '../../'),
      env: {
        ...process.env,
        PORT: serverPort.toString(),
        DB_PATH: dbPath,
        NODE_ENV: 'test',
      },
      stdio: 'inherit',
    });

    // Start Vite
    console.log(`Starting Vite on port ${vitePort}...`);
    const viteProcess = spawn('node', ['node_modules/.bin/vite', `--port`, vitePort.toString()], {
      cwd: path.resolve(__dirname, '../../'),
      env: {
        ...process.env,
        SERVER_PORT: serverPort.toString(),
      },
      stdio: 'inherit',
    });

    // Wait for server health check
    let healthy = false;
    const start = Date.now();
    while (Date.now() - start < 60000) {
      try {
        const res = await fetch(`http://localhost:${serverPort}/api/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch (e) {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!healthy) {
      serverProcess.kill();
      viteProcess.kill();
      throw new Error('Server failed to start in time');
    }

    // Also wait for Vite to be ready
    let viteReady = false;
    const viteStart = Date.now();
    while (Date.now() - viteStart < 30000) {
      try {
        const res = await fetch(baseUrl);
        if (res.ok) {
          viteReady = true;
          break;
        }
      } catch (e) {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!viteReady) {
      serverProcess.kill();
      viteProcess.kill();
      throw new Error('Vite failed to start in time');
    }

    await use({
      serverProcess,
      viteProcess,
      baseUrl,
      wsUrl,
    });

    serverProcess.kill();
    viteProcess.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },
  claimPage: async ({ page }, use) => {
    await use(new ClaimPage(page));
  },
});

export { expect };
