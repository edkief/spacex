import { test, expect } from './fixtures';
import { ClaimPage } from './pages/claim';

test.describe('Core Game Flow', () => {
  test('claim callsign and render game', async ({ page, gameServer, claimPage }) => {
    page.on('console', (msg) => console.log(`BROWSER CONSOLE: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`BROWSER ERROR: ${err.message}`));

    await page.goto(gameServer.baseUrl);
    await page.screenshot({ path: '.ralph/screenshots/e2e-debug-1.png' });

    const callsign = `PILOT-${Date.now().toString().slice(-6)}`;
    await claimPage.claimCallsign(callsign);

    // Wait for the game to load and the HUD to appear
    await expect(page.getByText('Drift Scaffold')).toBeVisible();
    await page.screenshot({ path: '.ralph/screenshots/e2e-debug-2.png' });

    // Check if the player list shows the callsign
    await expect(page.getByText(callsign, { exact: true })).toBeVisible();

    // Headless WebGL check: read pixels from the canvas
    const canvas = page.locator('#main-canvas');
    await expect(canvas).toBeVisible();

    const pixels = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return null;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return null;

      const width = 32;
      const height = 32;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Array.from(pixels);
    });

    expect(pixels).not.toBeNull();

    // Verify variance: not all pixels are the same (not a black or single-color screen)
    const firstPixel = pixels![0];
    const hasVariance = pixels!.some((p) => p !== firstPixel);
    expect(hasVariance).toBe(true);
  });
});

test.describe('Multiplayer Interaction', () => {
  test('two players see each other and chat', async ({ browser, gameServer }) => {
    const callsign1 = `PLAYER1-${Date.now().toString().slice(-6)}`;
    const callsign2 = `PLAYER2-${Date.now().toString().slice(-6)}`;

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const claimPage1 = new ClaimPage(page1);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    const claimPage2 = new ClaimPage(page2);

    await page1.goto(gameServer.baseUrl);
    await claimPage1.claimCallsign(callsign1);
    await expect(page1.getByText(callsign1, { exact: true })).toBeVisible();

    await page2.goto(gameServer.baseUrl);
    await claimPage2.claimCallsign(callsign2);
    await expect(page2.getByText(callsign2, { exact: true })).toBeVisible();

    // Verify presence
    await expect(page1.getByText(callsign2, { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page2.getByText(callsign1, { exact: true })).toBeVisible({ timeout: 5000 });

    // Chat test
    const message = `Hello from ${callsign1}! ${Date.now()}`;

    // Press Enter to show the chat input
    await page1.keyboard.press('Enter');

    // The input has no placeholder, but it's the only input that appears
    await page1.locator('input').fill(message);
    await page1.keyboard.press('Enter');

    await expect(page2.getByText(message)).toBeVisible({ timeout: 5000 });

    await context1.close();
    await context2.close();
  });
});
