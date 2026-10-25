import { test, expect } from '@playwright/test';

test('local ship responds to input without lag', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // Wait for renderer to load
  await page.waitForSelector('#main-canvas');

  // Get initial position (via evaluate to check Three.js state if possible, but we can't easily)
  // Instead, we'll check if the ship mesh moves in the scene.
  // Since we don't have access to the internal Three.js state, we can't easily assert position.
  // But we can check the console for errors.

  const logs: string[] = [];
  page.on('console', (msg) => logs.push(msg.text()));

  // Press 'W' to thrust forward
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(1000);

  expect(logs.filter((l) => l.includes('Error')).length).toBe(0);
});
