import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-56 — E2E: the first-launch experience (the headline test) + the
 * returning-player boot paths.
 *
 * Test 1 (fresh claim, the headline): fresh context → claims panel (title,
 * intro, Claim disabled) → type a callsign → the 500 ms debounced
 * availability probe flips '#claims-status' to 'available' and enables
 * Claim → click → STRAIGHT into the game at the home-system dock (no
 * intermediate screen: the docked indicator is up) → guidance step 1 shows
 * bottom-center → X dismisses it for good (persisted as 4) → screenshot.
 *
 * Test 2 (refresh restore): claim via raw REST (the disembark.spec.ts
 * pattern), seed both localStorage keys, reload → straight into the game
 * with NO claims screen; the guidance (furthest step) survives the refresh.
 *
 * Test 3 (expired token): a stored token /api/session rejects → silently
 * back to the claims screen with the expired message and the old callsign
 * prefilled + disabled (no error wall).
 */

const SHOTS = path.join(__dirname, '../../../.ralph/screenshots');

test('first launch: fresh claim → dock spawn → guidance step 1 → X dismiss', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('pilot');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);

  // (1) First load, no token: the claims panel — title, intro, Claim
  //     disabled until the debounced probe says the callsign is free.
  await claim.goto();
  await expect(page.locator('#claims-title')).toHaveText('DRIFT');
  await expect(page.locator('#claims-intro')).toBeVisible();
  await expect(page.locator('#claim-button')).toBeDisabled();

  // (2) Live validation: type → 500 ms debounce → probe → 'available'.
  await claim.callsignInput.fill(callsign);
  await expect(page.locator('#claims-status')).toHaveText('available', {
    timeout: 5_000,
  });
  await expect(page.locator('#claim-button')).toBeEnabled();

  // (3) Claim → the session is established and the game loads DIRECTLY into
  //     the home system (the claims screen goes away, no intermediate view).
  await claim.joinButton.click();
  await expect(page.locator('#claims-screen')).toHaveCount(0);
  await expect(claim.playerList).toContainText(`${callsign} (you)`);
  await expect(page.locator('#sys-id')).toBeVisible();

  // (4) Dock spawn: the starter ship spawns AT the home-system dock — a
  //     scout hull within the dock's ±100 m square around the system origin
  //     (TASK-20), rendered on screen (dev-only probe; e2e runs the dev build).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const probe = window.__SELF_SHIP__?.probe();
          if (!probe || !probe.pos) return null;
          const d = Math.hypot(probe.pos.x, probe.pos.y, probe.pos.z);
          return probe.classId === 'scout' && d <= 200 ? probe : null;
        }),
      { timeout: 20_000, message: 'starter ship not spawned at the home-system dock' },
    )
    .not.toBeNull();

  // (5) Guidance: step 1's hint line, bottom-center, for a fresh profile.
  const hint = page.locator('#guidance-hint');
  await expect(hint).toBeVisible({ timeout: 15_000 });
  await expect(hint).toContainText('Hold W to fly toward the star');

  // (6) X dismisses the guidance for good — persisted as 4, never returns.
  await page.keyboard.press('x');
  await expect(hint).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('drift.guidance'))).toBe('4');

  await page.screenshot({ path: path.join(SHOTS, 'TASK-56-1.png') });
  assertClean();
  await context.close();
});

interface ClaimResponse {
  token: string;
  callsign: string;
  homeSystemId: string;
}

test('refresh: stored session restores straight into the game (no claims screen)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(60_000);
  const callsign = uniqueCallsign('rest');

  // Claim via raw REST so the test is self-contained (disembark.spec.ts).
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  // Both keys: the app reads drift.token first, drift.session.v1 carries
  // the callsign (and stays the e2e-seeding contract).
  await page.evaluate((s) => {
    localStorage.setItem('drift.token', s.token);
    localStorage.setItem('drift.session.v1', JSON.stringify(s));
  }, session);
  await page.reload();

  // Straight into the game: NO claims screen at any point, status line up,
  // our "(you)" row in the player list — zero form interaction.
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`);
  await expect(page.locator('#claims-screen')).toHaveCount(0);

  // The guidance survives the refresh: a fresh profile resumes at step 1.
  await expect(page.locator('#guidance-hint')).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: path.join(SHOTS, 'TASK-56-2.png') });
  assertClean();
  await context.close();
});

test('expired token: silently back to the claims screen (no error wall)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  const context = await browser.newContext();
  const page = await context.newPage();
  const { errors } = collectErrors(page);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  // A stored session whose token /api/session will reject (garbage token).
  await page.evaluate(() => {
    localStorage.setItem('drift.token', 'expired-token-0000');
    localStorage.setItem(
      'drift.session.v1',
      JSON.stringify({
        token: 'expired-token-0000',
        callsign: 'old-pilot',
        playerId: 'p0',
        homeSystemId: '0000000000000000',
      }),
    );
  });
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  // The claims screen comes back: the expired message, the old callsign
  // prefilled and DISABLED (v1 has no recovery), no error wall anywhere.
  await expect(page.locator('#claims-screen')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#claims-expired')).toBeVisible();
  await expect(page.locator('#claims-expired')).toContainText('session expired');
  const input = page.locator('#callsign-input');
  await expect(input).toHaveValue('old-pilot');
  await expect(input).toBeDisabled();

  // The /api/session 401 shows up as console NETWORK noise (a failed
  // resource load) on this path by design — allow exactly that, nothing else.
  expect(
    errors.filter((e) => !e.includes('401 (Unauthorized)')),
    `console/page errors: ${errors.join(' | ')}`,
  ).toEqual([]);
  await context.close();
});
