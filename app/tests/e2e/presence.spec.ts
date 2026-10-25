import { test, expect } from '@playwright/test';

test('presence list should show other players', async ({ browser }) => {
  const context1 = await browser.newContext();
  const page1 = await context1.newPage();
  page1.on('console', (msg) => console.log(`Page1 [${msg.type()}]: ${msg.text()}`));
  page1.on('pageerror', (err) => console.log(`Page1 Error: ${err.message}`));
  await page1.goto('http://localhost:3000');
  await page1.screenshot({ path: '.ralph/screenshots/debug-1.png' });

  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  page2.on('console', (msg) => console.log(`Page2 [${msg.type()}]: ${msg.text()}`));
  page2.on('pageerror', (err) => console.log(`Page2 Error: ${err.message}`));
  await page2.goto('http://localhost:3000');
  await page2.screenshot({ path: '.ralph/screenshots/debug-2.png' });

  // Give it some time for WebSocket handshakes and presence broadcasts
  await page1.waitForTimeout(2000);

  // Verify presence HUD is visible on both
  await expect(page1.getByText('SYSTEM PRESENCE')).toBeVisible();
  await expect(page2.getByText('SYSTEM PRESENCE')).toBeVisible();

  // Take screenshots for verification
  await page1.screenshot({ path: '.ralph/screenshots/TASK-15-0.png' });
  await page2.screenshot({ path: '.ralph/screenshots/TASK-15-1.png' });

  await context1.close();
  await context2.close();
});
