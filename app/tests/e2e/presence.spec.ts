import { test, expect } from './fixtures';
import { ClaimPage } from './pages/claim';

test('presence list should show other players', async ({ browser, gameServer }) => {
  const callsign1 = `PRES1-${Date.now().toString().slice(-6)}`;
  const callsign2 = `PRES2-${Date.now().toString().slice(-6)}`;

  const context1 = await browser.newContext();
  const page1 = await context1.newPage();
  const claimPage1 = new ClaimPage(page1);
  page1.on('console', (msg) => console.log(`Page1 [${msg.type()}]: ${msg.text()}`));
  page1.on('pageerror', (err) => console.log(`Page1 Error: ${err.message}`));
  await page1.goto(gameServer.baseUrl);
  await claimPage1.claimCallsign(callsign1);

  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  const claimPage2 = new ClaimPage(page2);
  page2.on('console', (msg) => console.log(`Page2 [${msg.type()}]: ${msg.text()}`));
  page2.on('pageerror', (err) => console.log(`Page2 Error: ${err.message}`));
  await page2.goto(gameServer.baseUrl);
  await claimPage2.claimCallsign(callsign2);

  // Give it some time for WebSocket handshakes and presence broadcasts
  await page1.waitForTimeout(2000);

  // Verify presence HUD is visible on both
  await expect(page1.getByText('SYSTEM PRESENCE')).toBeVisible();
  await expect(page2.getByText('SYSTEM PRESENCE')).toBeVisible();

  // Verify they see each other
  await expect(page1.getByText(callsign2)).toBeVisible();
  await expect(page2.getByText(callsign1)).toBeVisible();

  // Take screenshots for verification
  await page1.screenshot({ path: '.ralph/screenshots/TASK-15-0.png' });
  await page2.screenshot({ path: '.ralph/screenshots/TASK-15-1.png' });

  await context1.close();
  await context2.close();
});
