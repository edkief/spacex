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
 * is what tells them apart). TASK-74 extends this scenario: a live ai-ship
 * spawned 60 m dead ahead must also RENDER — the remote layer builds its
 * class mesh and the dev __REMOTE_SHIPS__ probe asserts the projection.
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

  // The screenshot: player list with the AI section.
  const png = await page.screenshot();
  await fs.writeFile(path.join(__dirname, '../../../.ralph/screenshots/TASK-45-1.png'), png);

  // TASK-74: the rogue ships actually RENDER. Spawn a live ai-ship 60 m dead
  // ahead (the TASK-44 dummy assist — the seeded roster's positions are not
  // guaranteed to sit in the view cone) and assert it projects in front of
  // the chase camera via the dev __REMOTE_SHIPS__ probe.
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('drift.session.v1');
    return raw ? (JSON.parse(raw) as { token: string }).token : null;
  });
  expect(token).toBeTruthy();
  const res = await fetch(`${baseURL}/api/dev/dummy-target`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ distance: 60 }),
  });
  expect(res.status).toBe(200);

  const probeAi = async (): Promise<{
    callsign: string | null;
    classId: string | null;
    dist: number;
  } | null> => {
    const ships = (await page.evaluate(() => window.__REMOTE_SHIPS__?.probe() ?? [])) as Array<{
      kind: string;
      classId: string | null;
      callsign: string | null;
      screen: { x: number; y: number; dist: number } | null;
    }>;
    // NEAREST in-view rogue: the seeded roster can carry far ships in front
    // of the camera too — only the 60 m dummy is close enough to resolve.
    const ai = ships
      .filter((s) => s.kind === 'ai-ship' && s.screen !== null)
      .sort((a, b) => a.screen!.dist - b.screen!.dist)[0];
    return ai ? { callsign: ai.callsign, classId: ai.classId, dist: ai.screen!.dist } : null;
  };
  await expect
    .poll(() => probeAi(), {
      timeout: 15_000,
      message: 'an ai-ship never projected in front of the camera',
    })
    .not.toBeNull();
  const s = (await probeAi())!;
  expect(s.callsign).toBeTruthy(); // AI ships carry their roster name
  expect(s.dist).toBeGreaterThan(0);
  // The dummy sits 60 m dead ahead (+ the ~14 u chase offset) — a far
  // roster ship could never satisfy this.
  expect(s.dist).toBeLessThan(100);

  console.log(
    `[TASK-74] AI ship on screen: callsign=${s.callsign} class=${s.classId} dist=${s.dist.toFixed(1)} u`,
  );
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-74-2.png'),
  });

  assertClean();
  await context.close();
});
