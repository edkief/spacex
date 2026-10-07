import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-80 — E2E: pressing D turns RIGHT on screen (ship AND on foot).
 *
 * The pre-fix bug: the on-screen key pairs ([right, left] for yaw,
 * [left, right] for roll) were fed straight into a right-handed physics
 * frame (+Y up, +Z forward) where the ship's right is local −X — so D
 * turned LEFT and Q/E rolled the wrong way.
 *
 * SHIP: claim → chase camera arms → single W tap (undocks) → dev-teleport
 * into empty space (nothing can interfere) → read the probe's `rot` →
 * forward0 / right0 (= (−1,0,0) rotated by rot0 — the quaternion math is
 * inlined: Playwright cannot import @shared) → hold D 1 s → the new
 * forward must point toward the INITIAL right (dot > 0.2) → hold A 2 s →
 * dot < −0.2 (turned left of the initial facing, through and past it).
 *
 * ON FOOT: the disembark flow (pad-target → warp if needed → pad-teleport
 * → docked → browser → E) → read window.__CHAR__.rot (the server's 10 Hz
 * facing) → hold D 0.5 s → the facing must turn toward its initial right
 * the same way.
 *
 * Frame: right-handed, +Y up, +Z forward ⇒ right = local −X (the chase /
 * on-foot cameras look along +Z, so screen-right is −X).
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

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotate a vector by a unit quaternion (the inline @shared substitute). */
function quatRotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  // t = 2·cross(q.xyz, v);  v' = v + w·t + cross(q.xyz, t)
  const cx = y * v.z - z * v.y;
  const cy = z * v.x - x * v.z;
  const cz = x * v.y - y * v.x;
  const tx = 2 * cx;
  const ty = 2 * cy;
  const tz = 2 * cz;
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** The facing (+Z of the quat) and the character's right (−X of the quat). */
function frame(rot: Quat): { forward: Vec3; right: Vec3 } {
  return {
    forward: quatRotate(rot, { x: 0, y: 0, z: 1 }),
    right: quatRotate(rot, { x: -1, y: 0, z: 0 }),
  };
}

/** Dock the ship at the deterministic pad target (the disembark.spec.ts flow). */
async function dockAtPad(
  baseURL: string,
  apiPort: number,
  session: ClaimResponse,
): Promise<PadTarget> {
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
      (
        (m.payload as { entities: Array<{ callsign?: string; regime?: string; padId?: string }> })
          .entities ?? []
      ).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    'docked entity_update',
    15_000,
  );
  client.close();
  return target;
}

test('controls: D turns right, A turns left — in the ship and on foot', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);

  // (a) Claim — raw REST, same shape the claim flow stores in localStorage.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign: uniqueCallsign('ctrl') }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;

  // (b) The browser: the self-ship probe (chase camera armed).
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(baseURL);
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // (c) SHIP: one W tap takes the docked ship off; teleport into empty
  // space so nothing (terrain, pads, the pad machine) can interfere.
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ x: 0, y: 50, z: 3000 }),
  });
  expect(teleRes.status).toBe(200);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const p = window.__SELF_SHIP__?.probe()?.pos;
          return p ? Math.hypot(p.x - 0, p.y - 50, p.z - 3000) : Number.POSITIVE_INFINITY;
        }),
      { timeout: 20_000, message: 'ship never reached the empty-space teleport point' },
    )
    .toBeLessThan(50);

  // (d) D must turn the nose toward the ship's RIGHT (local −X at t0).
  const rot0 = (await page.evaluate(() => window.__SELF_SHIP__!.probe()!.rot)) as Quat;
  const right0 = frame(rot0).right;
  await page.keyboard.down('d');
  await page.waitForTimeout(1000);
  await page.keyboard.up('d');
  const rotD = (await page.evaluate(() => window.__SELF_SHIP__!.probe()!.rot)) as Quat;
  const dotD = dot(frame(rotD).forward, right0);
  expect(
    dotD,
    `D held 1 s: dot(forward, initial right) = ${dotD.toFixed(3)} (must be > 0.2)`,
  ).toBeGreaterThan(0.2);
  // The visual artifact: nose pointing RIGHT of the chase camera.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-80-1.png'),
  });

  // (e) A must turn the nose LEFT: 2 s of A swings 1.6 rad, through the
  // initial facing and onto its left side (dot < −0.2 against the SAME
  // initial right, as the D leg).
  await page.keyboard.down('a');
  await page.waitForTimeout(2000);
  await page.keyboard.up('a');
  const rotA = (await page.evaluate(() => window.__SELF_SHIP__!.probe()!.rot)) as Quat;
  const dotA = dot(frame(rotA).forward, right0);
  expect(
    dotA,
    `A held 2 s: dot(forward, initial right) = ${dotA.toFixed(3)} (must be < -0.2)`,
  ).toBeLessThan(-0.2);

  // (f) ON FOOT: dock at the pad, disembark, then D must turn the facing
  // right the same way (the server's 10 Hz facing via window.__CHAR__).
  const target = await dockAtPad(baseURL, apiPort, session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  // The character must be spawned client-side (the on-foot loop only steps
  // after the self-character entity lands).
  await expect
    .poll(() => page.evaluate(() => !!window.__CHAR__?.pos), {
      timeout: 15_000,
      message: 'self character never arrived over the wire',
    })
    .toBe(true);
  // The wire OMITS identity quaternions (the disembark facing IS identity),
  // so an absent rot reads as identity until the first real turn.
  const cRot0 = ((await page.evaluate(() => window.__CHAR__?.rot)) as Quat | undefined) ?? {
    x: 0,
    y: 0,
    z: 0,
    w: 1,
  };
  const cRight0 = frame(cRot0).right;
  await page.keyboard.down('d');
  await page.waitForTimeout(500);
  await page.keyboard.up('d');
  // Wait for the 10 Hz snapshot feed to carry the turned (non-identity)
  // facing before reading it.
  await expect
    .poll(() => page.evaluate(() => !!window.__CHAR__?.rot), {
      timeout: 5_000,
      message: 'turned character facing never arrived over the wire',
    })
    .toBe(true);
  const cRotD = (await page.evaluate(() => window.__CHAR__!.rot)) as Quat;
  const cDotD = dot(frame(cRotD).forward, cRight0);
  expect(
    cDotD,
    `on foot, D held 0.5 s: dot(facing, initial right) = ${cDotD.toFixed(3)} (must be > 0.2)`,
  ).toBeGreaterThan(0.2);

  console.log(
    `[TASK-80] ship D dot=${dotD.toFixed(3)} (want > 0.2), A dot=${dotA.toFixed(3)} (want < -0.2), ` +
      `on-foot D dot=${cDotD.toFixed(3)} (want > 0.2)`,
  );

  assertClean();
  await context.close();
});
