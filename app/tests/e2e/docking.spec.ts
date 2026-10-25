import { test, expect } from './fixtures';
import { ClaimPage } from './pages/claim';

test.describe('Landing Pad Docking', () => {
  test('should show DOCKED indicator when ship is at station pad', async ({ page, gameServer, claimPage }) => {
    await page.goto(gameServer.baseUrl);

    const callsign = `DOCKPILOT-${Date.now().toString().slice(-6)}`;
    await claimPage.claimCallsign(callsign);

    // Wait for game to load
    await expect(page.getByText('Drift Scaffold')).toBeVisible();

    // Use debug teleport to move ship to the station pad
    await page.evaluate(() => {
      return (window as any).__DRIFT__.teleportToPad();
    });


    // The server update takes a few ticks to broadcast.
    // We expect the "DOCKED" text to appear in the HUD.
    await expect(page.getByText('DOCKED', { exact: true })).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: '.ralph/screenshots/TASK-29-docked.png' });
  });
});
