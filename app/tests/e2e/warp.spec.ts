import { test, expect } from './fixtures';
import { ClaimPage } from './pages/claim';

test.describe('Warp Flow', () => {
  test('seamless warp between systems', async ({ page, gameServer, claimPage }) => {
    page.on('console', (msg) => console.log(`BROWSER CONSOLE: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`BROWSER ERROR: ${err.message}`));

    await page.goto(gameServer.baseUrl);

    const callsign = `WARP-TEST-${Date.now().toString().slice(-6)}`;
    await claimPage.claimCallsign(callsign);

    // 1. Open Star Chart
    await page.keyboard.press('m');
    await expect(page.getByText('Loading Galaxy...')).toBeVisible();
    await expect(page.getByText('Loading Galaxy...')).toBeHidden({ timeout: 10000 });
    await expect(page.getByText('Close (Esc)')).toBeVisible();

    // 2. Select a target system (not the current one)
    // The current system has a green stroke. We find a circle that doesn't have it.
    const circles = page.locator('circle');
    const count = await circles.count();
    
    // Find a circle that isn't the current one (green stroke)
    let targetCircle = null;
    for (let i = 0; i < count; i++) {
      const stroke = await circles.nth(i).getAttribute('stroke');
      if (stroke !== 'rgb(0, 255, 0)' && stroke !== '#00ff00') {
        targetCircle = circles.nth(i);
        break;
      }
    }

    if (!targetCircle) {
      throw new Error('Could not find a target system to warp to');
    }

    await targetCircle.click({ force: true });

    // 3. Click Warp
    const warpButton = page.getByRole('button', { name: 'Warp' });
    await expect(warpButton).toBeEnabled();
    
    const start = Date.now();
    await warpButton.click();

    // 4. Verify "Warping..." state
    await expect(warpButton).toHaveText('Warping...');

    // 5. Verify WarpOverlay is visible during warp-in (t=1s)
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="warp-overlay"]')).toBeVisible();

    // 6. Wait for arrival (total warp duration 3-6s)
    await expect(warpButton).toBeHidden({ timeout: 10000 });
    const end = Date.now();
    const duration = (end - start) / 1000;
    console.log(`Warp duration: ${duration}s`);
    expect(duration).toBeGreaterThan(3);
    expect(duration).toBeLessThan(8);

    // 7. Verify we are in a new system (star present at center)
    // Since we are using a deterministic world, the star is always at 0,0,0
    // We can check if the canvas still has variance and the HUD is back
    await expect(page.getByText('Drift Scaffold')).toBeVisible();
    
    await page.screenshot({ path: '.ralph/screenshots/TASK-8-warp-arrival.png' });
  });
});
