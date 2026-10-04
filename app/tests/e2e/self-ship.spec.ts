import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-72 — E2E: a freshly claimed player sees their OWN ship. Before this
 * task the client never rendered the player's ship and the camera sat at a
 * fixed spectator vantage (150, 40, 150); now the first self ship
 * entity_update spawns the scene-level self-ship mesh and arms the
 * third-person CHASE camera behind it.
 *
 * Assertion path (no GL pixel math needed): the dev-only __SELF_SHIP__ hook
 * (src/client/self-ship-debug.ts) exposes the ship's world position and its
 * LIVE projection through the chase camera (WorldManager.projectToScreen).
 * Within one snapshot of joining the ship must project INSIDE the viewport
 * and NEAR the view center — which is only true of a chase camera behind
 * the ship, never of the old fixed vantage (the home dock is seeded
 * anywhere in [-100, 100], far from (150, 40, 150)'s star-centered view).
 *
 * Screenshot: .ralph/screenshots/TASK-72-1.png (the ship in front of the
 * camera).
 */

test('self ship: rendered + centred in the chase view within one snapshot of joining', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(uniqueCallsign('selfship'));
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // The first self ship update (the boot snapshot or the first 10 Hz
  // entity_update, ≤ 100 ms after the world is up) spawns the mesh and
  // arms the chase camera. Poll the live probe until the ship projects
  // inside the viewport (screen != null = in front of the camera).
  const inView = await expect
    .poll(
      () =>
        page.evaluate(() => {
          const p = window.__SELF_SHIP__?.probe() ?? null;
          return p !== null && p.screen !== null && p.classId !== null;
        }),
      {
        timeout: 20_000,
        message: 'self ship never projected in front of the camera',
      },
    )
    .toBe(true);
  void inView;

  // Near the view CENTER (a chase cam sits 14 u behind / 4 u above, looking
  // 20 u ahead: the ship origin lands slightly below screen center — allow
  // 25 % of the viewport in each axis, which the old spectator vantage
  // cannot satisfy for a docked ship anywhere in the seeded spawn area).
  const probe = await page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe() ?? null;
    return p
      ? {
          classId: p.classId,
          pos: p.pos,
          x: p.screen?.x ?? null,
          y: p.screen?.y ?? null,
          dist: p.screen?.dist ?? null,
          w: window.innerWidth,
          h: window.innerHeight,
        }
      : null;
  });
  expect(probe, 'self ship probe never materialized').not.toBeNull();
  const p = probe!;
  // A fresh player docks the scout.
  expect(p.classId).toBe('scout');
  expect(p.x).not.toBeNull();
  expect(p.y).not.toBeNull();
  expect(p.x!).toBeGreaterThanOrEqual(0);
  expect(p.x!).toBeLessThanOrEqual(p.w);
  expect(p.y!).toBeGreaterThanOrEqual(0);
  expect(p.y!).toBeLessThanOrEqual(p.h);
  expect(Math.abs(p.x! - p.w / 2), 'ship should be near the view center (x)').toBeLessThanOrEqual(
    p.w * 0.25,
  );
  expect(Math.abs(p.y! - p.h / 2), 'ship should be near the view center (y)').toBeLessThanOrEqual(
    p.h * 0.25,
  );
  // And the camera is BEHIND it, close: the chase distance is ~14.6 u
  // (14 back, 4 up) — never the hundreds-of-units spectator vantage.
  expect(p.dist).not.toBeNull();
  expect(p.dist!).toBeGreaterThan(0);
  expect(p.dist!).toBeLessThan(40);

  console.log(
    `[TASK-72] self ship on screen: class=${p.classId} ` +
      `pos=(${p.pos!.x.toFixed(1)}, ${p.pos!.y.toFixed(1)}, ${p.pos!.z.toFixed(1)}) ` +
      `screen=(${p.x!.toFixed(0)}, ${p.y!.toFixed(0)}) of ${p.w}x${p.h} ` +
      `dist=${p.dist!.toFixed(1)} u`,
  );

  // The camera holds: 1 s later the ship is still centred (the chase rig
  // tracks the docked ship — no drift back to the spectator vantage).
  await page.waitForTimeout(1000);
  const held = await page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe() ?? null;
    if (!p?.screen) return null;
    return { x: p.screen.x, y: p.screen.y, w: window.innerWidth, h: window.innerHeight };
  });
  expect(held, 'ship lost from the view after 1 s').not.toBeNull();
  expect(Math.abs(held!.x - held!.w / 2)).toBeLessThanOrEqual(held!.w * 0.25);
  expect(Math.abs(held!.y - held!.h / 2)).toBeLessThanOrEqual(held!.h * 0.25);

  // The visual artifact: a ship, clearly in front of the camera.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-72-1.png'),
  });

  assertClean();
  await context.close();
});
