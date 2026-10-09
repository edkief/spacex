import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-94 — E2E: touch menu/nav access + the Controls Auto/On/Off toggle
 * (PRD §4.13, SC-6).
 *
 * Setup for BOTH tests: the starter scout spawns DOCKED at the HOME dock
 * (regime 'space' — a dock position, not a pad), so the browser boots
 * straight into the flight touch layout when touch is enabled. No
 * disembark / pad docking needed.
 *
 * Test 1 (touch-emulated, hasTouch → maxTouchPoints > 0, default 'auto'):
 *  (1) the touch overlay (incl. the MENU button) is visible;
 *  (2) the MENU button (driven through the SAME shared path it calls —
 *      the touchDebug openMenu passthrough, the TASK-91/92/93 pattern)
 *      opens the ESC menu → the star chart opens from it → a warp starts
 *      (the warp overlay mounts — the way warp.spec.ts / star-chart.spec.ts
 *      assert it). Screenshot TASK-94-1.png: the ESC menu opened by touch
 *      on the touch layout.
 *
 * Test 2 (desktop, default 'auto' → touchEnabled false):
 *  (1) the touch overlay is ABSENT (no #touch-controls);
 *  (2) Controls set to 'on' in the settings panel → the overlay APPEARS
 *      live (the flight layout) and PERSISTS: the server row round-trips
 *      ('on') and a RELOAD restores the toggle (the overlay is back —
 *      the settings.spec.ts persistence pattern);
 *  (3) Controls set to 'off' → the overlay hides again.
 *
 * The e2eServer fixture boots the real dev server (NODE_ENV=development →
 * the DEV-only __TOUCH__ hook exists); never run alongside npm run dev.
 */

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

/** Claim a player over REST (settings.spec.ts pattern). */
async function claimPlayer(baseURL: string, callsign: string): Promise<ClaimResponse> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ClaimResponse;
}

/** Boot the browser with the saved session into the home system. */
async function boot(
  page: import('@playwright/test').Page,
  baseURL: string,
  session: ClaimResponse,
) {
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${session.homeSystemId}`);
  // The starter ship is home-docked (regime 'space', a dock POSITION — no
  // padId, so no #docked-indicator): the ship HUD stubs prove the boot.
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });
}

/** The touchDebug hook as seen from the page. */
type TouchMenuHook = { openMenu: () => void };

test('touch device: overlay + MENU button → ESC menu → chart → warp (default auto)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(120_000);
  const session = await claimPlayer(baseURL, uniqueCallsign('t94a'));

  // The TOUCH-EMULATED browser (hasTouch → maxTouchPoints > 0 → 'auto'
  // resolves ON → the flight layout renders).
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await boot(page, baseURL, session);

  expect(await page.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);

  // (1) The overlay is up, including the MENU button (top-right, both
  //     sticks present — the flight layout).
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expect(page.locator('#touch-btn-menu')).toBeVisible();
  await expect(page.locator('#touch-btn-menu')).toContainText('MENU');
  await expect(page.locator('#touch-stick-left')).toBeVisible();
  await expect(page.locator('#touch-stick-right')).toBeVisible();

  // (2) The MENU button's action (the SAME shared open/pop the Esc key
  //     calls — driven through the touchDebug passthrough): the ESC menu
  //     opens from the empty stack.
  await page.evaluate(() =>
    (window as unknown as { __TOUCH__: TouchMenuHook }).__TOUCH__.openMenu(),
  );
  await expect(page.locator('#esc-menu')).toBeVisible();

  // Screenshot: the ESC menu opened by touch, over the touch flight layout.
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-94-1.png'),
  });

  // The menu is the SAME stack the Esc key opens: SYSTEMS → star chart.
  await page.locator('#esc-menu-systems').click();
  await expect(page.locator('#star-chart')).toBeVisible();
  await expect(page.locator('#star-chart-loading')).toBeHidden();

  // Select a non-current system → the Warp button enables.
  const other = page.locator('[data-testid="star-chart-node"][data-current="false"]');
  await expect(other).toHaveCount(2);
  await other.first().click();
  const warpButton = page.locator('#warp-button');
  await expect(warpButton).toBeEnabled();
  await expect(warpButton).toHaveText(/WARP — \d+(s|m \d+s|h \d+m)/);

  // A warp STARTS by touch (the overlay mounts — warp.spec.ts's assert).
  await warpButton.click();
  await expect(warpButton).toBeDisabled();
  await expect(page.locator('#warp-overlay')).toBeVisible({ timeout: 5_000 });

  assertClean();
  await context.close();
});

test('desktop: auto hides the overlay; on shows + persists; off hides (toggle round trip)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const session = await claimPlayer(baseURL, uniqueCallsign('t94b'));
  const auth = { authorization: `Bearer ${session.token}` };

  // The DESKTOP browser (no hasTouch → maxTouchPoints 0 → 'auto' is OFF).
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await boot(page, baseURL, session);

  expect(await page.evaluate(() => navigator.maxTouchPoints), 'desktop device').toBe(0);

  // (1) Default 'auto' on a desktop: the overlay is ABSENT.
  expect(await page.locator('#touch-controls').count(), 'no overlay on desktop auto').toBe(0);

  // (2) Controls → ON in the settings panel (ESC → SETTINGS).
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible();
  await page.locator('#esc-menu-settings').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#settings-controls-heading')).toBeVisible();
  const onBtn = page.locator('#settings-controls-on');
  await expect(onBtn).toHaveAttribute('aria-pressed', 'false');
  await onBtn.click();
  await expect(onBtn).toHaveAttribute('aria-pressed', 'true');

  // The overlay APPEARS live (the flight layout — the home dock is space).
  await expect(page.locator('#touch-controls')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('#touch-btn-menu')).toBeVisible();

  // Persistence round trip: the server row says 'on'.
  const getTouch = async (): Promise<string> => {
    const res = await fetch(`${baseURL}/api/players/settings`, { headers: auth });
    expect(res.status).toBe(200);
    return ((await res.json()) as { touchControls: string }).touchControls;
  };
  await expect.poll(getTouch, { timeout: 5_000, message: 'settings PUT round trip' }).toBe('on');

  // RELOAD: the restored row keeps the overlay up (boot fetch → apply).
  await page.goto(`${baseURL}/?sys=${session.homeSystemId}`);
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#touch-controls')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#touch-btn-menu')).toBeVisible();
  expect(await getTouch(), 'toggle still on after reload').toBe('on');

  // (3) Controls → OFF: the overlay hides again (live). The panel shows
  // the restored 'on' value from the server row.
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible();
  await page.locator('#esc-menu-settings').click();
  await expect(page.locator('#settings-controls-on')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#settings-controls-off').click();
  await expect
    .poll(async () => page.locator('#touch-controls').count(), { timeout: 5_000 })
    .toBe(0);
  expect(await getTouch(), 'toggle now off').toBe('off');

  assertClean();
  await context.close();
  void apiPort;
});
