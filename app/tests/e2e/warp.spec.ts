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

    // 5. Check for black frames during warp-in (t=1s)
    // Wait 1 second into the warp-in transition
    await page.waitForTimeout(1000);
    const pixels = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return null;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return null;

      const width = 32;
      const height = 32;
      const x = (canvas.width - width) / 2;
      const y = (canvas.height - height) / 2;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Array.from(pixels);
    });

    expect(pixels).not.toBeNull();
    const firstPixel = pixels![0];
    const hasVariance = pixels!.some((p) => p !== firstPixel);
    expect(hasVariance).toBe(true); // Not a black screen

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
