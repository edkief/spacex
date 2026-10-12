import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-105 — E2E: surface egress, the new off-pad half of the exit-ship gate.
 *
 * Step 1 (server-side, raw REST + WS — the enter-ship.spec.ts pattern):
 * claim → pad target → join/warp → dev-teleport onto the pad → the pad
 * machine docks the ship (regime 'docked' + padId, SERVER-authoritative) →
 * close the raw client (the ship idles at the pad, state kept).
 *
 * Step 2 (browser, the REAL client): the docked ship renders the DOCKED
 * indicator + the "LEAVE SHIP" prompt (the pad path — already covered by
 * disembark.spec.ts, asserted here only as the pre-state). Then the dev
 * teleport moves the SHIP ~100 m off the pad at pad height (flat terrain,
 * pad.y is the ground proxy); the pad machine releases it (25 m hysteresis)
 * and the regime machine settles it to 'surface' — the DOCKED indicator
 * hides and the leave-ship prompt STAYS visible: the new client gate (wire
 * flightRegime 'surface' + speed < EXIT_SHIP_MAX_SPEED, state/exit-ship).
 *
 * Step 3: E sends 'exit_ship' off-pad → the character entity spawns on the
 * TERRAIN height 2.5 m to the ship's side (characterSpawnPos, not the pad
 * plane) → on-foot HUD active, geometry asserted server-authoritatively
 * (window.__CHAR__, 10 Hz) against the captured ship pose. Screenshot.
 *
 * Step 4: the turn-burst loop (enter-ship.spec.ts) finds '[E] Enter ship',
 * E re-enters — the off-pad re-entry rule is unchanged; the ship is NOT
 * pad-docked, so the DOCKED indicator stays hidden and the leave-ship
 * prompt comes back from the landed gate alone. Console stays clean.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

interface PadTarget {
  systemId: string;
  planetId: string;
  padId: string;
  pad: { x: number; y: number; z: number };
}

/** The ship parked ~100 m east of the pad (flat terrain, pad.y = ground proxy). */
const OFF_PAD = 100;

interface EntityState {
  id: string;
  kind: string;
  pos: { x: number; y: number; z: number };
  regime: string;
  padId?: string;
  callsign?: string;
}

/** Dock the player's ship at the seeded pad server-side (enter-ship.spec.ts flow). */
async function dockAtPad(baseURL: string, apiPort: number, session: ClaimResponse) {
  const auth = { authorization: `Bearer ${session.token}` };
  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;

  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (target.systemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: target.systemId });
    await client.next((m) => m.type === 'warp_arrived', 'warp_arrived (pad system)', 10_000);
  }
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over
  return target;
}

test('landed ship off-pad: E disembarks onto the terrain, re-entry works', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('egress');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  const auth = { authorization: `Bearer ${session.token}` };
  console.log(`[surface-egress] callsign=${session.callsign} padSystem=${target.systemId}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  // Pre-state: pad-docked (the disembark.spec.ts half — asserted, not re-tested).
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });

  // (2) OFF-PAD: teleport the SHIP ~100 m east of the pad, 5 m up (the
  // same offset the pad flow uses). The terrain off the pad is NOT flat
  // (it can sit a couple of m above pad.y), so a pad-height drop would bury
  // the ship; the 5 m drop lets the ground clamp settle it ON the terrain.
  // The pad machine releases (25 m hysteresis) and the regime machine
  // settles the resting ship to 'surface' — no padId, speed 0.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x + OFF_PAD, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);
  // The rendered hull snaps to the server truth (predictor snap reconcile).
  await page.waitForFunction(
    (t) => {
      const p = (
        window as unknown as {
          __SELF_SHIP__?: { probe(): { pos: { x: number; z: number } | null } | null };
        }
      ).__SELF_SHIP__?.probe()?.pos;
      return p && Math.hypot(p.x - t.x, p.z - t.z) < 5 ? true : null;
    },
    { x: target.pad.x + OFF_PAD, z: target.pad.z },
    { timeout: 20_000, polling: 100 },
  );
  // The NEW gate: not docked (indicator hidden) AND the leave-ship prompt
  // visible from the landed state alone (wire flightRegime 'surface' +
  // speed < EXIT_SHIP_MAX_SPEED, driven by the self entity_update).
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 15_000 });
  // Capture the ship pose (it stays FROZEN once the player disembarks, so
  // the on-foot geometry check below compares against this).
  const shipPos = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __SELF_SHIP__?: { probe(): { pos: { x: number; y: number; z: number } | null } | null };
        }
      ).__SELF_SHIP__?.probe()?.pos ?? null,
  )) as { x: number; y: number; z: number } | null;
  expect(shipPos, 'self ship pose captured').not.toBeNull();

  // (3) DISSEMBARK OFF-PAD: E sends 'exit_ship' → the character spawns on
  // the TERRAIN height 2.5 m to the ship's side (not the pad plane).
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden();
  // On-foot HUD active: the weight bar is the always-rendered on-foot node
  // (#hazard-hud only mounts inside a hazard zone — we are on open terrain).
  await expect(page.locator('#weight-bar')).toBeVisible({ timeout: 15_000 });
  const geo = (await page
    .waitForFunction(
      () => {
        const p = (
          window as unknown as { __CHAR__?: { pos: { x: number; y: number; z: number } | null } }
        ).__CHAR__?.pos;
        return p ?? null;
      },
      null,
      { timeout: 15_000, polling: 100 },
    )
    .then((h) => h.jsonValue())) as { x: number; y: number; z: number };
  // Both feet on the terrain near the ship: the shared side offset is
  // exactly 2.5 m in the ship's local frame (rendered pose ≈ wire pose).
  const dxz = Math.hypot(geo.x - shipPos!.x, geo.z - shipPos!.z);
  expect(dxz, "character 2.5 m to the ship's side").toBeGreaterThan(1.5);
  expect(dxz, "character 2.5 m to the ship's side").toBeLessThan(3.5);
  // The off-pad terrain is HILLY (integer-metre heightmap cells on a 5 m
  // grid): the terrain at the ship's (x, z) and 2.5 m to its side can
  // differ by a few metres, so Δy is a loose sanity bound (the character
  // is on the terrain — not buried, not floating), and the BINDING
  // invariant is the 3-D re-entry radius (the 5 m enter ship reach).
  expect(Math.abs(geo.y - shipPos!.y), 'character on terrain height at the ship').toBeLessThan(4);
  const d3 = Math.hypot(geo.x - shipPos!.x, geo.y - shipPos!.y, geo.z - shipPos!.z);
  expect(d3, 'character within the 5 m re-entry radius').toBeLessThan(5);
  await page.waitForTimeout(1_200); // the 600 ms handoff settles into the on-foot view
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-105-1.png'),
  });

  // (4) RE-ENTER (unchanged rule): the character spawns 2.5 m to the
  // ship's SIDE (the ±30° cone misses it), so burst 'd' (right, 3 rad/s)
  // until the ship enters the cone and '[E] Enter ship' shows (5 m enter
  // radius), then E. The loop RETRIES the E press (burst → E → check) until
  // re-entry lands: the landed ship sits at the CONE EDGE (its wire pos is
  // 1.5 m below the terrain feet on a slope), so a reconcile wobble or a
  // lagged 'd' keyup (the held-key release can trail the busy software-GL
  // main thread — enter-ship.spec.ts lesson) can clear the raycast between
  // the prompt showing and the E landing. Bounded 100 ms bursts + rest,
  // NOT one long hold; 24 × ~17° covers a full revolution with retries.
  const prompt = page.locator('#interact-prompt');
  const promptText = async (): Promise<string | null> =>
    prompt
      .isVisible()
      .then((v) => (v ? prompt.textContent() : null))
      .catch(() => null);
  const reentered = async (): Promise<boolean> =>
    page
      .locator('#leave-ship-prompt')
      .isVisible()
      .catch(() => false);
  for (let i = 0; i < 24; i++) {
    if (await reentered()) break; // re-entered (the landed gate prompt is back)
    await page.keyboard.down('d');
    await page.waitForTimeout(100);
    await page.keyboard.up('d');
    await page.waitForTimeout(300); // rest: the raycast settles
    if ((await promptText()) === '[E] Enter ship') {
      await page.keyboard.press('e');
      await page.waitForTimeout(600); // the reverse handoff settles
    }
  }
  // Off-pad re-entry: the ship is NOT pad-docked — the DOCKED indicator
  // stays hidden; the leave-ship prompt comes back from the LANDED gate
  // alone (the new canExitShip signal, not the docked store).
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });
  await expect(prompt).toBeHidden({ timeout: 5_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(1_500); // the 600 ms reverse handoff settles
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-105-2.png'),
  });

  assertClean();
  await context.close();
});
