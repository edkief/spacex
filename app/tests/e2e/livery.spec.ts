import { test, expect } from './fixtures';

test('livery picker should be visible and interactive', async ({ page, gameServer, claimPage }) => {
  await page.goto(gameServer.baseUrl);
  await claimPage.claimCallsign(`LIV-${Date.now().toString().slice(-6)}`);

  // Take screenshot for verification
  await page.screenshot({ path: '.ralph/screenshots/TASK-21-0.png' });

  // Check if the livery picker header is visible
  const header = page.locator('h2:has-text("Ship Customization")');
  await expect(header).toBeVisible();

  // Check for color inputs
  const colorInputs = page.locator('input[type="color"]');
  await expect(colorInputs).toHaveCount(3);

  // Change one color
  await colorInputs.nth(0).fill('#ff00ff');

  // Click apply
  const applyButton = page.locator('button:has-text("Apply Livery")');
  await applyButton.click();

  // Verify no error alert appears
  const alert = page.locator('text=Error saving livery');
  await expect(alert).not.toBeVisible();
});
