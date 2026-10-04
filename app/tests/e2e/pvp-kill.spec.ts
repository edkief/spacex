import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { RawWsClient } from './raw-ws';

/**
 * TASK-47 — E2E: player A lasers player B to the kill, and BOTH pages see
 * the kill feed entry 'A ▸ laser ▸ B' (pvp → white). The e2eServer fixture
 * boots the real dev server itself (random ports, tmp sqlite) — never run
 * alongside npm run dev.
 *
 * Positioning (the landing.spec.ts order): B's ship must PHYSICALLY be in
 * A's system — join_system only moves presence, only a WARP moves the ship
 * row — so B warps over via raw WS first (ship lands at A's spawn gate),
 * then BOTH ships are dev-teleported to the 60 km space anchor, 60 m apart
 * on +x (the same anchor shard.pvp.ws.test.ts uses — no terrain, no LOS).
 * Only then do the two browser contexts join A's system.
 *
 * Scouts carry the laser only (8 dmg, 3/s server rate), so the REAL client
 * path fires: A LMB-clicks the canvas 22 times at ~350 ms spacing; the
 * client's aim assist (nearest ship ≤ 800 m) targets B and the server's
 * targetId path re-derives the hit (range 400 m ≫ 60 m, LOS clear). A scout
 * (50 shields + 100 hull) dies on the 19th hit — the killing hit broadcasts
 * {kind:'kill', killer, victim, weapon} to the whole shard, and both pages
 * push the feed entry.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Session {
  token: string;
  callsign: string;
  homeSystemId: string;
}

/** The claim flow stores the session under this key (main.tsx). */
async function sessionOf(page: import('@playwright/test').Page): Promise<Session> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('drift.session.v1');
    if (!raw) throw new Error('no session in localStorage');
    return JSON.parse(raw) as Session;
  });
}

/** Raw REST claim (the shape the browser claim flow stores). */
async function claim(baseURL: string, callsign: string): Promise<Session> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Session;
}

/**
 * Warp the caller's ship to `targetSystemId` via raw WS (join home → warp →
 * warp_arrived), then close — the ship ROW stays in the target system while
 * the browser takes over (the landing.spec.ts pattern).
 */
async function warpShip(apiPort: number, session: Session, targetSystemId: string): Promise<void> {
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (targetSystemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: targetSystemId });
    await client.next(
      (m) =>
        m.type === 'warp_arrived' &&
        (m.payload as { systemId: string }).systemId === targetSystemId,
      `warp_arrived (${targetSystemId})`,
      10_000,
    );
  }
  client.close();
}

/** The dev-teleport assist (shard.teleportForTesting — e2e-only surface). */
async function teleport(
  baseURL: string,
  token: string,
  x: number,
  y: number,
  z: number,
): Promise<void> {
  const res = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ x, y, z }),
  });
  expect(res.status).toBe(200);
}

test('A lasers B to the kill: both kill feeds show the white pvp entry', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);

  // (1) A claims in the BROWSER (joins its home system — the fight's system);
  //     B claims raw REST (its browser joins AFTER the warp).
  const aCallsign = uniqueCallsign('pvp-a');
  const bCallsign = uniqueCallsign('pvp-b');
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const { assertClean: assertCleanA } = collectErrors(pageA);
  const claimA = new ClaimPage(pageA, baseURL);
  await claimA.claim(aCallsign);
  const sysId = await claimA.systemId();

  const b = await claim(baseURL, bCallsign);
  console.log(`[pvp-kill] A=${aCallsign} B=${bCallsign} system=${sysId} Bhome=${b.homeSystemId}`);

  // (2) Warp B's ship into A's system (ship row + entity move; the raw conn
  //     closes — B's ship idles at the spawn gate until the browser joins).
  await warpShip(apiPort, b, sysId);

  // (3) Dev-teleport BOTH ships to the 60 km space anchor, 60 m apart on +x
  //     (A at the anchor, B ahead of it) — deep space, no terrain, no pads.
  const a = await sessionOf(pageA);
  await teleport(baseURL, a.token, 60000, 60000, 0);
  await teleport(baseURL, b.token, 60060, 60000, 0);

  // (4) B's browser joins A's system with the SAME token — B's ship entity
  //     is adopted from the shard (now in space).
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const { assertClean: assertCleanB } = collectErrors(pageB);
  await pageB.goto(baseURL);
  await pageB.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), b);
  await pageB.goto(`${baseURL}/?sys=${sysId}`);
  await expect(pageB.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  // Regime machine re-resolves to space + the 10 Hz batches refresh each
  // client's remote-ship list (the aim assist's candidate set).
  await pageA.waitForTimeout(1500);

  // (5) A fires the REAL client path: LMB on the canvas. Each mousedown sends
  //     a 'fire' frame with the aim-assist targetId (B, the only other ship).
  //     22 clicks at 350 ms covers the 19-hit kill (50/8 shields + 100/8
  //     hull) with margin for the first few unsynced clicks.
  const box = await pageA.locator('#game-canvas').boundingBox();
  if (!box) throw new Error('no bounding box for #game-canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 22; i++) {
    await pageA.mouse.click(cx, cy);
    await pageA.waitForTimeout(350);
  }

  // (6) The 'kill' event broadcast reaches BOTH pages → the feed entry
  //     'A ▸ laser ▸ B' (pvp → white). It lives 10 s, so screenshot soon.
  const entryText = `${aCallsign} ▸ laser ▸ ${bCallsign}`;
  await expect(pageA.locator('#kill-feed')).toContainText(entryText, { timeout: 20_000 });
  await expect(pageB.locator('#kill-feed')).toContainText(entryText, { timeout: 20_000 });

  // pvp (victim kind 'ship', not 'ai-ship') renders white, not grey.
  const color = await pageA
    .locator('#kill-feed div')
    .last()
    .evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgb(255, 255, 255)');

  await pageA.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-47-1.png'),
  });

  assertCleanA();
  assertCleanB();
  await contextA.close();
  await contextB.close();
});

/**
 * TASK-49 — E2E: the death-and-recovery loop. Same kill as the TASK-47
 * test, then: (a) B's page shows the 2 s 'SHIP LOST' moment naming A;
 * (b) A's page shows the wreck's killer marker label '▸ A' (the wreck is
 * 60 m ahead of A's nose — B is teleported along A's CURRENT forward
 * vector, read from __SELF_SHIP__, so it is inside the chase camera's
 * view); (c) the moment auto-hides and B's ship is the docked respawned
 * scout (#docked-indicator).
 */
test('A kills B: SHIP LOST moment, wreck killer marker, docked scout respawn', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);

  // (1) A claims in the browser; B claims raw and warps into A's system.
  const aCallsign = uniqueCallsign('wreck-a');
  const bCallsign = uniqueCallsign('wreck-b');
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const { assertClean: assertCleanA } = collectErrors(pageA);
  const claimA = new ClaimPage(pageA, baseURL);
  await claimA.claim(aCallsign);
  const sysId = await claimA.systemId();

  const b = await claim(baseURL, bCallsign);
  console.log(
    `[pvp-kill/49] A=${aCallsign} B=${bCallsign} system=${sysId} Bhome=${b.homeSystemId}`,
  );
  await warpShip(apiPort, b, sysId);

  // (2) Read A's CURRENT orientation, then dev-teleport A to the 60 km
  //     space anchor with B 60 m ahead along A's forward vector (the
  //     chase camera looks along it → the wreck lands in A's view).
  const probeShip = async (): Promise<{
    pos: { x: number; y: number; z: number };
    rot: { x: number; y: number; z: number; w: number };
  } | null> =>
    pageA.evaluate(() => {
      const r = (
        window as unknown as { __SELF_SHIP__?: { probe: () => unknown } }
      ).__SELF_SHIP__?.probe();
      const probe = r as
        | {
            pos: { x: number; y: number; z: number } | null;
            rot: { x: number; y: number; z: number; w: number } | null;
          }
        | undefined;
      // null until the ship has spawned (rot non-null).
      return probe?.rot ? { pos: probe.pos!, rot: probe.rot } : null;
    });
  await expect.poll(probeShip, { timeout: 20_000 }).not.toBe(null);
  const r = (await probeShip())!;
  // Ship forward = local +Z under the ship quat (the pose-math convention).
  const { x: qx, y: qy, z: qz, w: qw } = r.rot;
  const fwd = {
    x: 2 * (qx * qz + qy * qw),
    y: 2 * (qy * qz - qx * qw),
    z: 1 - 2 * (qx * qx + qy * qy),
  };
  const A_POS = { x: 60_000, y: 60_000, z: 0 };
  const B_POS = {
    x: A_POS.x + 60 * fwd.x,
    y: A_POS.y + 60 * fwd.y,
    z: A_POS.z + 60 * fwd.z,
  };
  const a = await sessionOf(pageA);
  await teleport(baseURL, a.token, A_POS.x, A_POS.y, A_POS.z);
  await teleport(baseURL, b.token, B_POS.x, B_POS.y, B_POS.z);

  // (3) B's browser joins A's system with the same token.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const { assertClean: assertCleanB } = collectErrors(pageB);
  await pageB.goto(baseURL);
  await pageB.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), b);
  await pageB.goto(`${baseURL}/?sys=${sysId}`);
  await expect(pageB.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  await pageA.waitForTimeout(1500);

  // (4) A fires the real client path (22 LMB clicks at 350 ms — the 19th
  //     hit is the kill). The moment watcher runs CONCURRENTLY: the 2 s
  //     window must not close before the assertion catches it.
  const box = await pageA.locator('#game-canvas').boundingBox();
  if (!box) throw new Error('no bounding box for #game-canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const momentVisible = expect(pageB.locator('#ship-lost')).toContainText(
    `${bCallsign}Killed by ${aCallsign}`,
    { timeout: 30_000 },
  );
  for (let i = 0; i < 22; i++) {
    await pageA.mouse.click(cx, cy);
    await pageA.waitForTimeout(350);
  }
  await momentVisible;
  await pageB.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-49-1.png'),
  });

  // (5) A's page: the wreck's killer marker label '▸ A' (60 m away, inside
  //     the 200 m marker range and the chase camera's view).
  await expect(pageA.locator('#remote-labels div', { hasText: `▸ ${aCallsign}` })).toBeVisible({
    timeout: 20_000,
  });
  await pageA.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-49-2.png'),
  });

  // (6) The moment auto-hides after 2 s and B's ship is the docked
  //     respawned scout (the DOCKED indicator is up on B's page).
  await expect(pageB.locator('#ship-lost')).toBeHidden({ timeout: 10_000 });
  await expect(pageB.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await pageB.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-49-3.png'),
  });

  assertCleanA();
  assertCleanB();
  await contextA.close();
  await contextB.close();
});
