import path from 'node:path';
import { test, expect } from '@playwright/test';

/** TASK-68 happy-path smoke: shell renders, health endpoint answers. */
test('scaffold smoke: canvas shell + health endpoint', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await expect(page.locator('#root')).toContainText('DRIFT');

  const res = await page.request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.galaxySeed).toBe('string');

  await page.waitForTimeout(500);
  await expect(page.locator('#root')).toContainText('server ok');

  await page.screenshot({
    path: path.join(__dirname, '../../.agent/screenshots/TASK-68-1.png'),
    fullPage: true,
  });

  expect(consoleErrors).toEqual([]);
});
