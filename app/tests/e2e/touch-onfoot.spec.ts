import path from 'node:path';
import WebSocket from 'ws';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-93 — E2E: on-foot play by touch (PRD §4.13, SC-6), server-confirmed.
 *
 * The on-foot setup mirrors walk.spec.ts / interact.spec.ts /
 * enter-ship.spec.ts: claim → pad target → raw WS dock → the TOUCH-EMULATED
 * browser (hasTouch → maxTouchPoints > 0 → the layout renders) takes over
 * the same token, disembarks (the keyboard E — the on-foot layout is not
 * up yet while docked) and goes on foot. From there EVERY drive goes
 * through the touchDebug dev hook (window.__TOUCH__ — functions can't
 * cross the page boundary, so every drive is a page.evaluate over the
 * live hook, the TASK-91/92 pattern):
 *  (1) LAYOUT: the on-foot layout is up in the surface regime (MOVE stick
 *      + RUN / JUMP / DROP / INTERACT); the flight sticks are NOT.
 *  (2) MOVE: move({thrust: 1}) for ~2.5 s → the SERVER-reported position
 *      advances ≥ 4 m (walk = 3 u/s; the same __CHAR__ tap walk.spec.ts
 *      uses); release; move({yaw: 1}) burst → the heading turns (dot of
 *      the facing with the pre-burst facing < 0.8).
 *  (3) MINE: a deposit 1.5 m in front of the CURRENT facing (the
 *      interact.spec geometry) → the prompt appears; an INTERRUPTED
 *      interactPress/interactRelease pair (600 ms < 1.5 s channel) awards
 *      NOTHING (the weight bar stays 0/40u, the deposit keeps its unit —
 *      mine-stop cancels); a FULL hold (> 1.5 s) awards the unit
 *      (1/40u, the deposit despawns, the prompt hides).
 *  (4) RE-ENTER: thrust back toward the ship (S), then the
 *      enter-ship.spec prompt-as-sensor approach (W bursts in the far
 *      zone, yaw nudges at the cone edge) until '[E] Enter ship' holds;
 *      interactPress() re-enters the ship (the docked HUD stubs return —
 *      the same asserts enter-ship.spec.ts makes). Screenshot with the
 *      interact prompt up.
 *
 * The e2eServer fixture boots the real dev server (NODE_ENV=development →
 * the DEV-only __TOUCH__ / __CHAR__ hooks exist); never run alongside
 * npm run dev.
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

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The touchDebug hook as seen from the page (the e2e drives through it). */
interface TouchHook {
  move: (c: { thrust?: number; yaw?: number }) => void;
  run: (on: boolean) => void;
  jump: (on: boolean) => void;
  interactPress: () => void;
  interactRelease: () => void;
  drop: () => void;
}

type TouchFn = 'move' | 'run' | 'jump' | 'interactPress' | 'interactRelease' | 'drop';

/** Drive ONE on-foot touchDebug action INSIDE the page (the TASK-92 pattern). */
const touch = (page: Page, fn: TouchFn, arg?: unknown): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const hook = (window as unknown as { __TOUCH__?: TouchHook }).__TOUCH__;
      if (!hook) throw new Error('no __TOUCH__ hook');
      switch (f as TouchFn) {
        case 'move':
          hook.move(a as { thrust?: number; yaw?: number });
          return null;
        case 'run':
          hook.run(Boolean(a));
          return null;
        case 'jump':
          hook.jump(Boolean(a));
          return null;
        case 'interactPress':
          hook.interactPress();
          return null;
        case 'interactRelease':
          hook.interactRelease();
          return null;
        case 'drop':
          hook.drop();
          return null;
      }
    },
    [fn, arg] as [TouchFn, unknown],
  );

/** Dock the player's ship at the seeded pad server-side (walk.spec.ts flow). */
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
      (
        (m.payload as { entities: Array<{ callsign?: string; regime?: string; padId?: string }> })
          .entities ?? []
      ).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over
  return target;
}

/** The last SERVER-authoritative self-character position (dev hook, TASK-32). */
async function charPos(page: Page): Promise<Vec3> {
  const p = (await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, {
      timeout: 15_000,
    })
    .then((h) => h.jsonValue())) as Vec3 | null;
  expect(p, 'character position from __CHAR__').not.toBeNull();
  return p!;
}

/** The character's CURRENT facing (from the __CHAR__ rot quat — TASK-30+ probe math). */
async function charForward(page: Page): Promise<Vec3> {
  const f = await page.evaluate(() => {
    const r = window.__CHAR__?.rot;
    if (!r) return null;
    const { x, y, z, w } = r;
    return { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
  });
  expect(f, 'character facing from __CHAR__.rot').not.toBeNull();
  return f!;
}

/**
 * Wait until the character has come to REST (server position via __CHAR__,
 * 10 Hz): no movement > 6 cm per 100 ms poll for 600 ms (the enter-ship
 * spec's settle — the release coast must end before the prompt is used).
 */
async function charSettled(page: Page): Promise<void> {
  type Settle = { x: number | null; z: number | null; t: number };
  await page.evaluate(() => {
    (window as unknown as { __settle?: Settle }).__settle = { x: null, z: null, t: 0 };
  });
  await page.waitForFunction(
    () => {
      const p = window.__CHAR__?.pos;
      const s = (window as unknown as { __settle?: Settle }).__settle;
      if (!p || !s) return null;
      const now = Date.now();
      if (s.x === null || s.z === null || Math.hypot(p.x - s.x, p.z - s.z) > 0.06) {
        s.x = p.x;
        s.z = p.z;
        s.t = now;
        return null;
      }
      return now - s.t >= 600 ? true : null;
    },
    null,
    { timeout: 15_000, polling: 100 },
  );
}

test('touch on-foot: MOVE stick + RUN/JUMP/DROP/INTERACT (mine + re-enter, server-confirmed)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(180_000);
  const callsign = uniqueCallsign('t93');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[TASK-93] callsign=${session.callsign} padSystem=${target.systemId}`);

  // The TOUCH-EMULATED browser (hasTouch → maxTouchPoints > 0 → the gate
  // opens and the layout renders).
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  expect(await page.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);
  expect(
    await page.evaluate(() => !!window.__TOUCH__?.interactPress),
    'touchDebug on-foot hook installed',
  ).toBe(true);

  // Disembark (the keyboard E — the on-foot layout is not up while docked);
  // the character entity arrives, the docked HUD stubs clear.
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  await charPos(page);

  // (1) LAYOUT: the on-foot layout is up in the surface regime; the flight
  //     sticks (and the combat cluster) are NOT.
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expect(page.locator('#touch-stick-move')).toBeVisible();
  await expect(page.locator('#touch-btn-run')).toContainText('RUN');
  await expect(page.locator('#touch-btn-jump')).toContainText('JUMP');
  await expect(page.locator('#touch-btn-drop')).toContainText('DROP');
  await expect(page.locator('#touch-btn-interact')).toContainText('INTERACT');
  expect(await page.locator('#touch-stick-left').count(), 'no flight left stick on foot').toBe(0);
  expect(await page.locator('#touch-stick-right').count(), 'no flight right stick on foot').toBe(0);
  expect(await page.locator('#touch-btn-fire').count(), 'no combat cluster on foot').toBe(0);

  // (2a) MOVE — THRUST: move({thrust: 1}) for ~2.5 s → the SERVER position
  //      advances ≥ 4 m (walk = 3 u/s → ~7 m; latency-tolerant floor).
  const start = await charPos(page);
  await touch(page, 'move', { thrust: 1 });
  await page.waitForTimeout(2_500);
  await touch(page, 'move', { thrust: 0 });
  const walked = (await page
    .waitForFunction(
      (s: { x: number; z: number }) => {
        const p = window.__CHAR__?.pos;
        return p && Math.hypot(p.x - s.x, p.z - s.z) >= 4 ? p : null;
      },
      { x: start.x, z: start.z },
      { timeout: 10_000, polling: 100 },
    )
    .then((h) => h.jsonValue())) as Vec3;
  expect(Math.hypot(walked.x - start.x, walked.z - start.z)).toBeGreaterThanOrEqual(4);
  // Walking keeps the character ON the pad plane (flat disc — no drift down).
  expect(Math.abs(walked.y - start.y)).toBeLessThan(1);

  // (2b) MOVE — YAW: a 400 ms yaw=+1 burst turns the nose (3 rad/s →
  //      ~1.2 rad; even a latency-trimmed burst beats the 0.8 dot floor by
  //      a wide margin). The pre-burst facing is +Z (identity — the spawn
  //      facing the thrust leg never rotates; the wire omits an identity
  //      quat, so it is compared, not read).
  await touch(page, 'move', { yaw: 1 });
  await page.waitForTimeout(400);
  await touch(page, 'move', { yaw: 0 });
  await charSettled(page);
  const facing1 = await charForward(page);
  const dotYaw = facing1.z; // dot(facing, +Z)
  expect(
    dotYaw,
    `yaw burst: dot(facing, +Z) = ${dotYaw.toFixed(3)} (must be < 0.8 — turned)`,
  ).toBeLessThan(0.8);

  // (3) MINE: a deposit 1.5 m IN FRONT of the CURRENT facing (the
  //     interact.spec geometry — inside the 3 m reach / 30° cone).
  const pos0 = await charPos(page);
  const fwd0 = await charForward(page);
  const depRes = await fetch(`${baseURL}/api/dev/deposit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      x: pos0.x + fwd0.x * 1.5,
      y: pos0.y + fwd0.y * 1.5,
      z: pos0.z + fwd0.z * 1.5,
      quantity: 1,
    }),
  });
  expect(depRes.status).toBe(200);
  const deposit = (await depRes.json()) as { ok: boolean; depositId: string };
  expect(deposit.ok).toBe(true);
  console.log(`[TASK-93] deposit=${deposit.depositId}`);

  const prompt = page.locator('#interact-prompt');
  const bar = page.locator('#weight-bar');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt).toContainText('mine iron');
  // The bar starts empty (the fresh player owns nothing).
  await expect(bar).toHaveText(/0\/40u/, { timeout: 10_000 });

  // (3a) INTERRUPTED HOLD: press, 600 ms (< the 1.5 s channel), release.
  //      mine-stop cancels — NOTHING is awarded.
  await touch(page, 'interactPress');
  await expect(page.locator('#mining-hud')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await touch(page, 'interactRelease');
  await expect(page.locator('#mining-hud')).toBeHidden({ timeout: 10_000 });
  await expect(bar).toHaveText(/0\/40u/, { timeout: 10_000 });
  // The deposit is untouched (quantity 1 via the dev probe).
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const d = (window.__DEPOSITS__?.deposits() ?? []).find((x) => x.depositId === id);
          return d ? d.quantity : null;
        }, deposit.depositId),
      {
        timeout: 10_000,
        message: `deposit ${deposit.depositId} quantity after the cancelled hold`,
      },
    )
    .toBe(1);

  // (3b) FULL HOLD: press, > 1.5 s (one full server channel tick), release.
  //      The unit is awarded (1/40u), the deposit despawns, the prompt hides.
  await touch(page, 'interactPress');
  await expect(page.locator('#mining-hud')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_800);
  await touch(page, 'interactRelease');
  await expect(bar).toHaveText(/1\/40u/, { timeout: 15_000 });
  await expect(prompt).toBeHidden({ timeout: 10_000 });

  // (4) RE-ENTER: steer BACK to the ship (docked at the pad — its position
  //     is known server-side), then the enter-ship.spec PROMPT-AS-SENSOR
  //     approach until '[E] Enter ship' holds. A blind S walk can't work:
  //     the mining leg left the facing yawed ~69° off the walked line, so
  //     backward drift parks the character metres off the return line.
  //     Steering granularity on this page: a 100 ms yaw burst RELEASES
  //     late (the software-GL main thread queues the rAF read — the
  //     enter-ship.spec TURN-step comment), so each nudge turns ~70°
  //     regardless of the burst length. A sign-chase ("nudge toward the
  //     signed bearing") therefore PING-PONGS (residue oscillates ±40°
  //     and never lands in the 20° alignment cone). The loop instead
  //     treats the FACING as a tool, not a target — every pass (read at
  //     REST; the 400 ms rest + charSettled() absorb the release tails):
  //      - '[E] Open cargo' (the docked ship's 3–5 m TASK-39 sub-prompt:
  //        in the cone, 3–5 m out) → a W burst sized to land ~1.8 m out
  //        crosses the 3 m boundary into the '[E] Enter ship' near zone.
  //      - hidden AND |bearing| ≤ 45° → WALK a burst sized to land ~3.5 m
  //        out: any facing within 90° of the ship shortens the distance
  //        (cos > 0), and walking ALONG the bearing shrinks the relative
  //        bearing itself — the geometry self-aligns as it closes.
  //      - hidden AND |bearing| > 45° → one yaw nudge toward the SIGNED
  //        bearing (recomputed from __CHAR__.rot each pass): the residue
  //        after ANY nudge is ≤ ~70°, so at most two nudges bring the
  //        facing into the walk zone from the worst case (180°).
  const promptText = async (): Promise<string | null> =>
    prompt
      .isVisible()
      .then((v) => (v ? prompt.textContent() : null))
      .catch(() => null);
  const shipPos = { x: target.pad.x, z: target.pad.z };
  for (let i = 0; i < 60; i++) {
    const text = await promptText();
    if (text === '[E] Enter ship') break;
    if (text === '[E] Open cargo') {
      const p2 = await charPos(page);
      const d2 = Math.hypot(shipPos.x - p2.x, shipPos.z - p2.z);
      await touch(page, 'move', { thrust: 1 });
      await page.waitForTimeout(Math.max(150, Math.min(1_500, ((d2 - 1.8) / 3) * 1000)));
      await touch(page, 'move', { thrust: 0 });
    } else {
      // Hidden: the signed bearing from the facing toward the ship
      // (atan2(cross, dot); cross_y > 0 = the ship is to the character's
      // RIGHT — yaw +1 → 'd').
      const p = await charPos(page);
      const f = await charForward(page);
      const dx = shipPos.x - p.x;
      const dz = shipPos.z - p.z;
      const dist = Math.hypot(dx, dz);
      const angle = Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz);
      if (Math.abs(angle) <= 0.79) {
        // walk zone: close the gap, sized to land ~3.5 m out — inside the
        // 3–5 m '[E] Open cargo' sub-prompt zone, so the prompt branch
        // (below) makes the final 1.8 m approach. Sizing to 2.5 m let the
        // release coast + the late yaw tail carry the character PAST the
        // ship (measured 0.37 m overshoot), the path that triggers the
        // pre-existing NaN-BigInt terrain flake (it hits enter-ship.spec.ts
        // too — generic on-foot walking near the docked ship, product-side).
        await touch(page, 'move', { thrust: 1 });
        await page.waitForTimeout(Math.max(150, Math.min(1_500, ((dist - 3.5) / 3) * 1000)));
        await touch(page, 'move', { thrust: 0 });
      } else {
        // off-axis: one nudge TOWARD the bearing. Measured (not assumed):
        // on this page a yaw +1 burst moves the bearing angle toward +
        // (the atan2 cross term grows), so the correction is the OPPOSITE
        // sign — chasing the sign makes the loop spin in place forever.
        const dir = angle > 0 ? -1 : 1;
        await touch(page, 'move', { yaw: dir });
        await page.waitForTimeout(100);
        await touch(page, 'move', { yaw: 0 });
      }
    }
    await page.waitForTimeout(400); // rest: absorb the release-event tail
    await charSettled(page);
  }
  await expect(prompt).toHaveText('[E] Enter ship', { timeout: 15_000 });
  // Stability: the prompt must HOLD (no boundary flicker) before the press.
  await page.waitForTimeout(400);
  await expect(prompt).toHaveText('[E] Enter ship');

  // Screenshot: the on-foot touch layout with the interact prompt up.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-93-1.png'),
  });

  // INTERACT re-enters: dispatches 'enter_ship' through the registry; the
  // server removes the character, re-activates the ship, the docked HUD
  // stubs return, the on-foot prompt is dead.
  await touch(page, 'interactPress');
  await expect(prompt).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 15_000 });
  // Back in the ship: the on-foot layout is gone (the flight regime layout
  // owns the controls again — no MOVE stick, no INTERACT button).
  expect(await page.locator('#touch-stick-move').count(), 'no on-foot layout in-ship').toBe(0);
  expect(await page.locator('#touch-btn-interact').count(), 'no INTERACT button in-ship').toBe(0);

  console.log(
    `[TASK-93] walked=${Math.hypot(walked.x - start.x, walked.z - start.z).toFixed(1)} m ` +
      `yaw-dot=${dotYaw.toFixed(3)} mined=1/40u re-entered=ok`,
  );

  assertClean();
  await context.close();
});
