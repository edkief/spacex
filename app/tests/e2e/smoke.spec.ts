import { expect, test } from '@playwright/test';
import { loadEndpointConfig } from '../../src/server/config.ts';
import { findAppDir, loadAppEnv } from '../../src/server/env.ts';

const { wsPath } = loadEndpointConfig(loadAppEnv(findAppDir(import.meta.dirname)));

test('loads the shell, canvas and proxied API/WS with no console errors', async ({
  page,
}, testInfo) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toContainText('Drift');
  await expect(page.locator('canvas#drift-canvas')).toHaveCount(1);

  const health = await page.request.get('/api/health');
  expect(health.ok()).toBe(true);
  const body = (await health.json()) as { ok: boolean; galaxySeed: string };
  expect(body.ok).toBe(true);
  expect(body.galaxySeed).toBeTruthy();

  const welcome = await page.evaluate(
    (path) =>
      new Promise<{ type: string; payload: { v: number; tickRate: number } }>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}${path}`);
        socket.onopen = () =>
          socket.send(JSON.stringify({ v: 1, type: 'hello', payload: { v: 1 } }));
        socket.onmessage = (event) => {
          resolve(JSON.parse(String(event.data)) as never);
          socket.close();
        };
        socket.onerror = () => reject(new Error('websocket error'));
      }),
    wsPath,
  );
  expect(welcome.type).toBe('welcome');
  expect(welcome.payload).toMatchObject({ v: 1, tickRate: 20 });

  await page.screenshot({ path: testInfo.outputPath('page.png') });
  expect(problems).toEqual([]);
});
