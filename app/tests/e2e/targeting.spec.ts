import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-44 — E2E: lock-on in the REAL client. Claim → the player spawns in
 * the docked scout → POST /api/dev/dummy-target spawns a static ai-ship 200 m
 * dead ahead → pressing T runs the client's cone selection + 'target_lock'
 * over the REAL socket; the server validates and the target box + the
 * TARGET LOCKED banner light. A second T releases (toggle) and the box goes.
 */

test('T locks the dummy ahead: target box + banner, second T releases', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(uniqueCallsign('tgt'));
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#weapon-hud')).toBeVisible({ timeout: 20_000 });

  // The session token (same shape the claim flow stores) for the dev route.
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('drift.session.v1');
    return raw ? (JSON.parse(raw) as { token: string }).token : null;
  });
  expect(token).toBeTruthy();

  // A live ai-ship 200 m dead ahead of the ship (inside the 500 m / 30° cone
  // by construction). The 10 Hz snapshot brings it into the client's entity
  // feed — the first T can race it, so the lock press is retried while the
  // store is still unlocked (a no-pick press sends nothing, so the toggle
  // can never accidentally fire a release between attempts).
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

  await expect(box).toContainText('AI-001');
  await expect(page.locator('#target-locked-banner')).toContainText('TARGET LOCKED');

  // The target box on screen (TASK-50 replaces this stub, same ids).
  const png = await page.screenshot();
  await fs.writeFile(path.join(__dirname, '../../../.ralph/screenshots/TASK-44-1.png'), png);

  // Second press: release → the box and the banner go away.
  await page.keyboard.press('t');
  await expect(box).toBeHidden({ timeout: 3_000 });
  await expect(page.locator('#target-locked-banner')).toBeHidden({ timeout: 3_000 });

  assertClean();
  await context.close();
});
