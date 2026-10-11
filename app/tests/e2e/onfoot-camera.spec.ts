import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-103 — E2E: the on-foot camera faces the character's facing
 * (facing-follow).
 *
 * The disembark flow gets the ship docked server-authoritatively (raw WS,
 * then closed — one connection per player), the browser takes over and
 * presses E to disembark. Then:
 *  - Phase A "straight walk: camera behind the facing" — holding W, the
 *    camera must sit ~4 m (3.2–4.8) BEHIND the character with its view
 *    direction within 20° of the character's facing.
 *  - Phase B "turn: camera swings to the new facing" — holding D for
 *    ~700 ms turns the character ≥ 60° (CHAR_TURN_RATE = 3 rad/s ≈
 *    172°/s); the camera must swing around to the NEW facing (≤ 20°) —
 *    pre-fix it stays at the stale world yaw and this never passes.
 *
 * Observations use existing dev-only hooks (no new ones): the camera world
 * position from window.__SELF_SHIP__.probe().camera.pos (the probe stays
 * alive on foot — the docked ship mesh keeps it, TASK-72), and the
 * character feet pos + facing quat from window.__CHAR__.pos / .rot
 * (server-authoritative, 10 Hz — hence the POLLS with 10 s budgets and the
 * 20° tolerance, not point-in-time asserts).
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

/** Minimal raw WS client (mirrors walk.spec.ts — app/src is off-limits to the runner). */
class RawWsClient {
  readonly messages: Envelope[] = [];
  closed = false;
  private ws: WebSocket;
  private wake: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Envelope);
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: Envelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  async next(predicate: (m: Envelope) => boolean, what: string, ms = 8000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

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

interface EntityState {
  id: string;
  kind: string;
  pos: { x: number; y: number; z: number };
  regime: string;
  padId?: string;
  callsign?: string;
}

/** Dock the player's ship at the seeded pad server-side (disembark flow). */
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

/** The camera's world position (the probe stays alive on foot). */
interface CamPos {
  x: number;
  y: number;
  z: number;
}

/** Character state read from __CHAR__ (server-authoritative, 10 Hz). */
interface CharSnap {
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
}

/**
 * Character forward from the yaw-only facing quat: rotate +Z by q →
 * (x, z) = (2(qx·qw + qy·qz), 1 − 2(qx² + qy²)) — a unit horizontal vector.
 */
function charForward(rot: { x: number; y: number; z: number; w: number }): {
  x: number;
  z: number;
} {
  return { x: 2 * (rot.x * rot.w + rot.y * rot.z), z: 1 - 2 * (rot.x * rot.x + rot.y * rot.y) };
}

/**
 * One in-page camera/character alignment sample (null = not ready yet):
 * horizontal cam→char distance, the angle (deg) between the horizontal
 * (char − cam) vector and the character forward, and the facing yaw.
 */
function sampleAlignment(
  ch: CharSnap,
  cam: CamPos,
): { dist: number; angDeg: number; yaw: number } | null {
  const fwd = charForward(ch.rot);
  const dx = ch.pos.x - cam.x;
  const dz = ch.pos.z - cam.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return null;
  const cos = (dx * fwd.x + dz * fwd.z) / dist; // fwd is unit
  const angDeg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  return { dist, angDeg, yaw: Math.atan2(fwd.x, fwd.z) };
}

/** Wrapped angle difference (rad), in [-π, π]. */
function angleDelta(a: number, b: number): number {
  return ((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

test('on foot: the camera sits behind the facing and swings to a new facing', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  // 'ofcam' keeps prefix + 8-char timestamp within the 16-char CALLSIGN_PATTERN.
  const callsign = uniqueCallsign('ofcam');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[onfoot-camera] callsign=${session.callsign} padSystem=${target.systemId}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // Disembark: E → the character entity arrives, the docked HUD stubs clear.
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });

  // Both hooks must be live: __CHAR__ (server-authoritative feet + facing)
  // and the __SELF_SHIP__ probe (camera world position — alive on foot).
  // rot may be OMITTED while the character faces identity (protocol
  // contract) — only pos + the camera probe gate readiness.
  await page.waitForFunction(
    () => Boolean(window.__CHAR__?.pos && window.__SELF_SHIP__?.probe()?.camera?.pos),
    null,
    { timeout: 15_000, polling: 100 },
  );

  const readPair = async (): Promise<{ ch: CharSnap; cam: CamPos }> => {
    const v = (await page.evaluate(() => {
      const ch = window.__CHAR__?.pos;
      const rot = window.__CHAR__?.rot ?? { x: 0, y: 0, z: 0, w: 1 };
      const cam = window.__SELF_SHIP__?.probe()?.camera?.pos;
      return ch && cam ? { ch: { pos: ch, rot }, cam } : null;
    })) as { ch: CharSnap; cam: CamPos } | null;
    if (!v) throw new Error('camera / character probe not ready');
    return v;
  };

  // Phase A: straight walk — holding W, the camera must settle ~4 m behind
  // the facing (the 4 m design + 10 Hz snapshot lag + follow smoothing).
  await page.keyboard.down('w');
  await page.waitForTimeout(2_000);
  await page.keyboard.up('w');
  const aligned = await (async () => {
    await page.waitForFunction(
      () => {
        const ch = window.__CHAR__?.pos;
        const rot = window.__CHAR__?.rot ?? { x: 0, y: 0, z: 0, w: 1 };
        const cam = window.__SELF_SHIP__?.probe()?.camera?.pos;
        if (!ch || !cam) return false;
        const fwd = {
          x: 2 * (rot.x * rot.w + rot.y * rot.z),
          z: 1 - 2 * (rot.x * rot.x + rot.y * rot.y),
        };
        const dx = ch.x - cam.x;
        const dz = ch.z - cam.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-6) return false;
        const angDeg =
          (Math.acos(Math.min(1, Math.max(-1, (dx * fwd.x + dz * fwd.z) / dist))) * 180) / Math.PI;
        return dist >= 3.2 && dist <= 4.8 && angDeg <= 20;
      },
      null,
      { timeout: 10_000, polling: 100 },
    );
    return readPair();
  })();
  const alignA = sampleAlignment(aligned.ch, aligned.cam)!;
  expect(alignA.dist, 'cam→char distance in [3.2, 4.8]').toBeGreaterThanOrEqual(3.2);
  expect(alignA.dist, 'cam→char distance in [3.2, 4.8]').toBeLessThanOrEqual(4.8);
  expect(alignA.angDeg, 'view within 20° of the facing').toBeLessThanOrEqual(20);
  console.log(
    `[onfoot-camera] phase A: dist=${alignA.dist.toFixed(2)}u ang=${alignA.angDeg.toFixed(1)}°`,
  );
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-103-1.png'),
  });

  // Phase B: turn — the character yaws ~120° (D for 700 ms at 172°/s) and
  // the camera must swing around to the NEW facing. Pre-fix the camera yaw
  // is frozen at the stale world yaw and this never passes.
  const { ch: ch0, cam: cam0 } = await readPair();
  const yaw0 = sampleAlignment(ch0, cam0)!.yaw;
  await page.keyboard.down('d');
  await page.waitForTimeout(700);
  await page.keyboard.up('d');
  const turned = await (async () => {
    await page.waitForFunction(
      (yaw0: number) => {
        const ch = window.__CHAR__?.pos;
        const rot = window.__CHAR__?.rot ?? { x: 0, y: 0, z: 0, w: 1 };
        const cam = window.__SELF_SHIP__?.probe()?.camera?.pos;
        if (!ch || !cam) return false;
        const fwd = {
          x: 2 * (rot.x * rot.w + rot.y * rot.z),
          z: 1 - 2 * (rot.x * rot.x + rot.y * rot.y),
        };
        const dx = ch.x - cam.x;
        const dz = ch.z - cam.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-6) return false;
        const angDeg =
          (Math.acos(Math.min(1, Math.max(-1, (dx * fwd.x + dz * fwd.z) / dist))) * 180) / Math.PI;
        if (!(dist >= 3.2 && dist <= 4.8 && angDeg <= 20)) return false;
        const yaw = Math.atan2(fwd.x, fwd.z);
        const d =
          ((((yaw - yaw0 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        return Math.abs(d) >= (60 * Math.PI) / 180;
      },
      yaw0,
      { timeout: 10_000, polling: 100 },
    );
    return readPair();
  })();
  const alignB = sampleAlignment(turned.ch, turned.cam)!;
  expect(Math.abs(angleDelta(alignB.yaw, yaw0)), 'character turned ≥ 60°').toBeGreaterThanOrEqual(
    (60 * Math.PI) / 180,
  );
  expect(alignB.angDeg, 'camera within 20° of the NEW facing').toBeLessThanOrEqual(20);
  expect(alignB.dist, 'cam→char distance in [3.2, 4.8]').toBeGreaterThanOrEqual(3.2);
  expect(alignB.dist, 'cam→char distance in [3.2, 4.8]').toBeLessThanOrEqual(4.8);
  console.log(
    `[onfoot-camera] phase B: Δyaw=${((Math.abs(angleDelta(alignB.yaw, yaw0)) * 180) / Math.PI).toFixed(1)}° ` +
      `dist=${alignB.dist.toFixed(2)}u ang=${alignB.angDeg.toFixed(1)}°`,
  );
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-103-2.png'),
  });
  assertClean();
  await context.close();
});
