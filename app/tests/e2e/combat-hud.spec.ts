import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-50 — E2E: the assembled COMBAT HUD in a real combat scene.
 * Claim → the player spawns in the docked scout → POST /api/dev/dummy-target
 * spawns a live ai-ship 200 m dead ahead → pressing T locks it (the REAL
 * client cone + server-validated 'target_lock', same path as
 * targeting.spec.ts): the TARGET BOX card (right of center) lights with the
 * AI callsign + 'AI' tag + hull/shield bars, and the rAF bracket tracks the
 * target's projected screen position. Then POST /api/dev/combat-kill
 * broadcasts a 'kill' combat_event (killer = the caller) → the KILL FEED
 * (top-center) shows the entry. The WEAPON READOUT (bottom-center) is up
 * throughout. Screenshot with the target box + kill feed visible.
 */

test('combat HUD: target box + bracket, kill feed entry, weapon readout', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  const callsign = uniqueCallsign('hud');
  await claim.claim(callsign);
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });
  // The weapon readout (bottom-center) is up as soon as the ship class lands.
  await expect(page.locator('#weapon-hud')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#weapon-hud')).toContainText('LASER');
  await expect(page.locator('#weapon-hud')).toContainText('100/100');

  // The session token (same shape the claim flow stores) for the dev routes.
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('drift.session.v1');
    return raw ? (JSON.parse(raw) as { token: string }).token : null;
  });
  expect(token).toBeTruthy();

  // A live ai-ship 200 m dead ahead (inside the 500 m / 30° lock cone by
  // construction). The 10 Hz snapshot brings it into the entity feed — the
  // first T can race it, so the lock press is retried while unlocked (a
  // no-pick press sends nothing, so the toggle can never fire a release).
  const res = await fetch(`${baseURL}/api/dev/dummy-target`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ distance: 200 }),
  });
  expect(res.status).toBe(200);
  const spawned = (await res.json()) as { ok: boolean; targetId: string };
  expect(spawned.ok).toBe(true);

  const box = page.locator('#target-box');
  let locked = false;
  for (let i = 0; i < 10 && !locked; i++) {
    await page.keyboard.press('t');
    locked = await box
      .waitFor({ state: 'visible', timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
  }
  expect(locked).toBe(true);

  // Target box card: AI callsign + 'AI' tag, the live distance, hull/shield.
  await expect(box).toContainText('AI-001');
  await expect(box.getByTestId('target-ai-tag')).toHaveText('AI');
  await expect(box).toContainText('m');
  await expect(box).toContainText('HULL');
  await expect(box).toContainText('SHLD');
  // The bracket tracks the projection (the target is dead ahead — in view).
  // The bracket ROOT is a 0×0 anchor (the corner marks are its positioned
  // children), so Playwright's toBeVisible (non-empty box) never passes on
  // it — assert the rAF-driven display state directly.
  await expect
    .poll(() => page.locator('#target-bracket').evaluate((el) => el.style.display === 'block'), {
      timeout: 3_000,
    })
    .toBe(true);

  // Scripted kill: the 'kill' combat_event (killer = the caller) feeds the
  // kill feed — '<callsign> ▸ laser ▸ AI-001-N' (PvE → grey).
  const killRes = await fetch(`${baseURL}/api/dev/combat-kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ victim: spawned.targetId, weapon: 'laser' }),
  });
  expect(killRes.status).toBe(200);
  const feed = page.locator('#kill-feed');
  await expect(feed).toContainText('▸ laser ▸ AI-001', { timeout: 10_000 });

  // The combat scene: target box (right of center) + kill feed (top-center)
  // + weapon readout (bottom-center), all visible at once.
  const png = await page.screenshot();
  await fs.writeFile(path.join(__dirname, '../../../.ralph/screenshots/TASK-50-1.png'), png);

  assertClean();
  await context.close();
});
