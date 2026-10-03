import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-45 — E2E: the seeded rogue roster in the REAL client. Claim → the
 * player enters their home system → the enter_system snapshot carries the
 * shard's 6-10 ai-ship entities (ai:true, pirate callsigns) → the PlayerList
 * derives its AI section from the entity list and renders each rogue's
 * callsign with a small 'AI' tag (the callsigns look like players — the tag
 * is what tells them apart; the ship rendering itself comes in a later task).
 */

test('the presence list shows the system rogues with an AI tag', async ({ browser, e2eServer }) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(uniqueCallsign('rogue'));
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#weapon-hud')).toBeVisible({ timeout: 20_000 });

  // The roster (6-10) rides the enter_system snapshot → the PlayerList's AI
  // section appears once the store ingests the entity list.
  const aiSection = page.locator('#player-list-ai');
  await expect(aiSection).toBeVisible({ timeout: 20_000 });
  const rows = aiSection.locator('[data-ai]');
  await expect(rows).toHaveCount(Number(await aiSection.getAttribute('data-ai-count')));
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(6);
  expect(count).toBeLessThanOrEqual(10);
  // Every row carries the 'AI' tag + a pirate callsign (3-16 alnum + dash):
  // the section text is `AI <callsign>` per row, so it must contain at
  // least `count` tag occurrences and a callsign-shaped token.
  const text = (await aiSection.innerText()).toUpperCase();
  expect(text.match(/\bAI\b/g)).toHaveLength(count);
  expect(text).toMatch(/[A-Z0-9-]{3,16}/);

  // The screenshot: player list with the AI section (ships render later).
  const png = await page.screenshot();
  await fs.writeFile(path.join(__dirname, '../../../.ralph/screenshots/TASK-45-1.png'), png);

  assertClean();
  await context.close();
});
