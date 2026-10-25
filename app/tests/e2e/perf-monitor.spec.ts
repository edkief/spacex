import { test, expect } from '@playwright/test';

test('debug overlay toggles with F3 and shows stats', async ({ page }) => {
  await page.goto('http://localhost:3000');
  
  // Claim a callsign to enter the game
  await page.fill('input[placeholder="CALLSIGN"]', 'perf123');
  await page.click('button:has-text("Claim and Enter System")');
  
  // Wait for the game to load (canvas should be visible)
  await expect(page.locator('#main-canvas')).toBeVisible({ timeout: 15000 });

  const overlay = page.locator('[data-testid="debug-overlay"]');
  
  // Initially should not be visible
  await expect(overlay).not.toBeVisible();
  
  // Press F3 to toggle
  await page.keyboard.press('F3');
  
  // Should be visible now
  await expect(overlay).toBeVisible();
  
  // Should contain some stats
  await expect(overlay).toContainText('FPS:');
  await expect(overlay).toContainText('p50:');
  await expect(overlay).toContainText('p95:');
  await expect(overlay).toContainText('p99:');
  await expect(overlay).toContainText('Calls:');
  await expect(overlay).toContainText('Tris:');
  await expect(overlay).toContainText('Ents:');
  
  // Press F3 again to hide
  await page.keyboard.press('F3');
  await expect(overlay).not.toBeVisible();
});
