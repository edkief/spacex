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

test('a browser claims a callsign, authenticates over the proxied socket and enters its home system', async ({
  page,
}, testInfo) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto('/');

  const callsign = `E2E-${Date.now().toString(36).toUpperCase()}`;
  const result = await page.evaluate(
    async ({ path, name }) => {
      const claim = await fetch('/api/callsigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callsign: name }),
      });
      const claimed = (await claim.json()) as {
        token: string;
        homeSystemId: string;
        callsign: string;
      };

      const seen: string[] = [];
      let enter: { payload: { systemId: string } } | undefined;
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}${path}`);
        const send = (type: string, payload: unknown) =>
          socket.send(JSON.stringify({ v: 1, type, payload }));
        socket.onopen = () => send('hello', { v: 1 });
        socket.onerror = () => reject(new Error('websocket error'));
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; payload: never };
          seen.push(message.type);
          if (message.type === 'welcome') send('auth', { token: claimed.token });
          if (message.type === 'auth_ok') send('join_system', { systemId: claimed.homeSystemId });
          if (message.type === 'enter_system') {
            enter = message;
            socket.close();
            resolve();
          }
          if (message.type === 'error') reject(new Error(JSON.stringify(message.payload)));
        };
      });
      return {
        status: claim.status,
        claimed: claimed.callsign,
        home: claimed.homeSystemId,
        seen,
        enter,
      };
    },
    { path: wsPath, name: callsign },
  );

  expect(result.status).toBe(201);
  expect(result.claimed).toBe(callsign);
  expect(result.seen).toEqual(['welcome', 'auth_ok', 'enter_system']);
  expect(result.enter?.payload.systemId).toBe(result.home);
  await page.screenshot({ path: testInfo.outputPath('claimed.png') });
  expect(problems).toEqual([]);
});
