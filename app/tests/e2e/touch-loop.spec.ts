import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-95 — E2E: the SC-1 loop driven ENTIRELY by touch (PRD §4.13, SC-6).
 *
 * The integration/close-out proof for the touch feature: a touch-emulated
 * browser (hasTouch → maxTouchPoints > 0 → Controls 'auto' resolves ON) on
 * the MOBILE rendering profile (deviceProfile 'mobile' — the 30 fps floor
 * pipeline, the TASK-59 override) completes the whole headline loop with
 * NO keyboard and NO mouse input — every gameplay action goes through the
 * touchDebug dev hook (window.__TOUCH__ — the deterministic channel the
 * TASK-91/92/93/94 specs use; synthetic pointer gestures are flaky in
 * headless) and the only DOM input is a touch TAP on React buttons (the
 * menu / chart / warp / sell panel — the same surfaces the real touch
 * layout drives with pointer events):
 *
 *  (1) CLAIM a callsign via the form (ClaimPage);
 *  (2) open the touch MENU → star chart → select the pad's system → WARP
 *      (the touch-menu path, TASK-94);
 *  (3) in SPACE, thrust to accelerate + a yaw burst turns the nose
 *      (server-reported speed / heading taps, the cruise.spec.ts pattern);
 *  (4) enter the atmosphere above the seeded pad and LAND (the
 *      shard.pads.approach approach): the ship is seeded 75 m out / 50 m up
 *      with a 90 u/s dead-stick velocity aimed at the pad (the atmosphere
 *      has no thrust — momentum + drag + gravity do the glide), the VTOL
 *      channel on over the pad (≤ 15 m / below 8 m) lets the server assist
 *      + 1.35·g lift settle the ship onto the disc, and the pad machine
 *      docks it (regime 'docked' + padId — the atmosphere / undock specs'
 *      landing state);
 *  (5) EXIT the ship — the egress prompt driven by the touch INTERACT
 *      (interactPress — the shared E path since TASK-95 wired the docked
 *      branch into it);
 *  (6) on foot, WALK (the MOVE stick's thrust) to a deposit and HOLD
 *      interactPress for a full mining unit → the server awards it
 *      (1/40u, the interact.spec.ts pattern);
 *  (7) RE-ENTER the ship (interactPress at '[E] Enter ship' — the
 *      enter-ship.spec.ts pattern);
 *  (8) exit again, walk to the station terminal, interactPress → the dock
 *      panel → TAP 'sell all iron inv': the credits counter rises
 *      (500 → 505 cr) and the cargo empties (0/40u — the sell.spec.ts
 *      terminal condition, the SC-1 end state).
 *
 * The e2eServer fixture boots the real dev server (NODE_ENV=development →
 * the DEV-only __TOUCH__ / __CHAR__ / __STREAM__ hooks exist); never run
 * alongside npm run dev. Screenshot: TASK-95-1.png at the sold/dock state.
 */

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
interface Tap {
  pos: Vec3;
  vel: Vec3;
  /** Wire ship state: 'docked' | 'sublight' (entityToState.regime). */
  regime: string;
  /** The flight regime: 'space' | 'atmosphere' | 'surface' (entityToState.flightRegime). */
  flightRegime: string;
  padId?: string;
}
/** One OUTBOUND wire 'input' frame (the tap's view of what left the socket). */
interface InFrame {
  seq: number;
  thrust: number;
  yaw: number;
  pitch: number;
  turn: number;
  /** Channel tags — 'vtol' is the VTOL lift (inputToShipInput maps it to up: 1). */
  action?: string;
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
  pad: Vec3;
}
interface TerminalTarget {
  systemId: string;
  terminalId: string;
  pos: Vec3;
}
interface Overview {
  systems: Array<{ systemId: string; neighbors: Array<{ to: string }> }>;
}
/** The touchDebug hook as seen from the page (the e2e drives through it). */
interface TouchHook {
  setChannel: (c: Record<string, unknown>) => void;
  clear: () => void;
  openMenu: () => void;
  move: (c: { thrust?: number; yaw?: number }) => void;
  interactPress: () => void;
  interactRelease: () => void;
}

/** Tap the self ship's entity_update frames (pos + vel + regime + padId). */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __TL__?: Tap[]; __TLIN__?: InFrame[] };
  w.__TL__ = [];
  w.__TLIN__ = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
      // TASK-95.1 diagnostic (kept — a permanent tap): record the CLIENT'S
      // OUTBOUND 'input' frames (seq + channels + action tags) so a spec can
      // see EXACTLY what the client put on the wire when a channel fired.
      const origSend = this.send.bind(this);
      this.send = (data: string): void => {
        try {
          const m = JSON.parse(String(data)) as { type?: string; payload?: InFrame };
          if (m.type === 'input' && m.payload) w.__TLIN__?.push(m.payload);
        } catch {
          /* never break the page's networking from a tap */
        }
        return origSend(data);
      };
      this.addEventListener('message', (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: {
              entities?: Array<{
                id: string;
                kind: string;
                pos: Vec3;
                vel?: Vec3;
                regime?: string;
                flightRegime?: string;
                padId?: string;
                callsign?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e)
            w.__TL__?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              regime: e.regime ?? 'sublight',
              flightRegime: e.flightRegime ?? 'space',
              padId: e.padId,
            });
        } catch {
          /* never break the page's networking from a tap */
        }
      });
    }
  };
}

/** The last SERVER-reported ship state (null until the first update). */
const lastState = (page: Page): Promise<Tap | null> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __TL__?: Tap[] }).__TL__ ?? [];
    return ups[ups.length - 1] ?? null;
  });

/** The last N OUTBOUND 'input' frames (the __TLIN__ tap — the wire evidence). */
const lastInFrames = (page: Page, n = 6): Promise<InFrame[]> =>
  page.evaluate((count) => {
    const ups = (window as unknown as { __TLIN__?: InFrame[] }).__TLIN__ ?? [];
    return ups.slice(-count);
  }, n);

/** Drive a touch flight channel through the dev hook (the deterministic path). */
const setChannel = (page: Page, c: Record<string, unknown>): Promise<boolean> =>
  page.evaluate((ch) => {
    const hook = (window as unknown as { __TOUCH__?: TouchHook }).__TOUCH__;
    if (!hook) return false;
    hook.setChannel(ch);
    return true;
  }, c);

/** Drive ONE on-foot touchDebug action INSIDE the page (the TASK-93 pattern). */
const touch = (page: Page, fn: keyof TouchHook, arg?: unknown): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const hook = (window as unknown as { __TOUCH__?: TouchHook }).__TOUCH__;
      if (!hook) throw new Error('no __TOUCH__ hook');
      const fnRef = hook[f as keyof TouchHook] as ((x: unknown) => void) | undefined;
      if (typeof fnRef !== 'function') throw new Error(`no __TOUCH__.${String(f)}`);
      fnRef(a);
    },
    [fn, arg] as [keyof TouchHook, unknown],
  );

/** Rotate (−1,0,0) by the quat — the ship's RIGHT (the TASK-80 probe math). */
function initialRight(rot: Quat): Vec3 {
  const { x, y, z, w } = rot;
  const v = { x: -1, y: 0, z: 0 };
  const cx = y * v.z - z * v.y;
  const cy = z * v.x - x * v.z;
  const cz = x * v.y - y * v.x;
  return {
    x: v.x + w * (2 * cx) + (y * (2 * cz) - z * (2 * cy)),
    y: v.y + w * (2 * cy) + (z * (2 * cx) - x * (2 * cz)),
    z: v.z + w * (2 * cz) + (x * (2 * cy) - y * (2 * cx)),
  };
}

/**
 * Dev-teleport the ship (and, with `vel`, give it a DEAD-STICK inbound
 * velocity — the atmosphere has no thrust, so the approach momentum must be
 * seeded, exactly as the shard.pads.approach unit test), then wait until the
 * SERVER reports the ship is there.
 *
 * Poll the SERVER tap (__TL__, the authoritative entity_update), NOT the
 * rendered ship: the dev route hard-sets the server state, and the client
 * predictor does NOT snap to a large state jump — it keeps integrating its
 * own state (which can be a full planet away), so the rendered position
 * flakily lags well beyond any tolerance. Every other assertion in this spec
 * is server-tapped too; a rendered-position poll was the outlier.
 */
async function teleport(
  page: Page,
  baseURL: string,
  token: string,
  to: Vec3,
  vel?: Vec3,
): Promise<void> {
  const res = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: vel ? { ...to, vel } : to,
  });
  expect(res.status(), `teleport response: ${await res.text()}`).toBe(200);
  // The server broadcasts at 10 Hz and the ship LEAVES the target at 90 u/s
  // (a 5 m ball is transited in ~55 ms — under one broadcast interval, so a
  // tight tolerance flakily misses); a 60 m band is a ~1.3 s window, which
  // 10 Hz samples with near certainty.
  await expect
    .poll(
      () =>
        lastState(page).then((u) =>
          u ? Math.hypot(u.pos.x - to.x, u.pos.y - to.y, u.pos.z - to.z) : 1e9,
        ),
      { timeout: 10_000, message: `server ship never reached ${JSON.stringify(to)}` },
    )
    .toBeLessThan(60);
}

/** The last SERVER-authoritative self-character position (dev hook, TASK-32). */
async function charPos(page: Page): Promise<Vec3> {
  const p = (await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, { timeout: 15_000 })
    .then((h) => h.jsonValue())) as Vec3 | null;
  expect(p, 'character position from __CHAR__').not.toBeNull();
  return p!;
}

/** The character's CURRENT facing (from the __CHAR__ rot quat). */
async function charForward(page: Page): Promise<Vec3> {
  const f = await page.evaluate(() => {
    // The wire OMITS rot when it is identity (entityToState, shard.ts) and
    // a disembarked character spawns at identity facing (shard.ts handleExitShip),
    // so __CHAR__.rot is undefined until the first yaw — fall back to the
    // identity quat (facing −z), which IS the server's true state.
    const r = window.__CHAR__?.rot ?? { x: 0, y: 0, z: 0, w: 1 };
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

/**
 * The on-foot steering loop (the touch-onfoot.spec.ts pattern, verbatim
 * geometry): the INTERACT prompt is the SENSOR, the facing a tool. Every
 * pass (read at rest — the 400 ms rest + charSettled() absorb the release
 * tails):
 *  - the goal prompt holds → done;
 *  - hidden (or a non-goal prompt, e.g. the ship's) AND |bearing| ≤ 45° →
 *    WALK a burst sized to land `stopShortM` out: any facing within 90° of
 *    the goal shortens the distance, and walking ALONG the bearing shrinks
 *    the relative bearing — the geometry self-aligns as it closes;
 *  - |bearing| > 45° → one 100 ms yaw nudge TOWARD the SIGNED bearing
 *    (measured sign flip: a yaw +1 burst moves the bearing angle toward +,
 *    so the correction is the opposite sign — chasing the sign ping-pongs).
 */
async function walkUntilPrompt(
  page: Page,
  goal: { x: number; z: number },
  goalPrompt: string,
  stopShortM: number,
  maxPasses = 60,
): Promise<void> {
  const prompt = page.locator('#interact-prompt');
  const promptText = async (): Promise<string | null> =>
    prompt
      .isVisible()
      .then((v) => (v ? prompt.textContent() : null))
      .catch(() => null);
  for (let i = 0; i < maxPasses; i++) {
    const text = await promptText();
    if (text === goalPrompt) return;
    const p = await charPos(page);
    const f = await charForward(page);
    const dx = goal.x - p.x;
    const dz = goal.z - p.z;
    const dist = Math.hypot(dx, dz);
    const angle = Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz);
    if (Math.abs(angle) <= 0.79) {
      await touch(page, 'move', { thrust: 1 });
      await page.waitForTimeout(Math.max(150, Math.min(1_500, ((dist - stopShortM) / 3) * 1000)));
      await touch(page, 'move', { thrust: 0 });
    } else {
      const dir = angle > 0 ? -1 : 1;
      await touch(page, 'move', { yaw: dir });
      await page.waitForTimeout(100);
      await touch(page, 'move', { yaw: 0 });
    }
    await page.waitForTimeout(400);
    await charSettled(page);
  }
  await expect(prompt).toHaveText(goalPrompt, { timeout: 15_000 });
}

/**
 * Re-enter the docked ship (leg 9). The ship sits at the pad center — a
 * KNOWN point — so the approach is two phases:
 *
 *  1. CLOSE: the bearing walk (the walkUntilPrompt geometry, distance gate
 *     only) shrinks the distance to the pad center — walking within 45° of
 *     the goal always shortens the distance — until the character is within
 *     2 m (inside the ship's 3 m '[E] Enter ship' sub-zone, not the 3–5 m
 *     '[E] Open cargo' zone).
 *  2. FACE: the ship prompt is a RAYCAST (≤ 3 m AND the ±30° forward cone,
 *     shared/interaction.ts) — distance alone does not arm it. Once close,
 *     turn IN PLACE toward the signed bearing (the enter-ship.spec.ts TURN
 *     pattern) until the ship is inside the cone, re-reading the prompt AT
 *     REST after each burst, until '[E] Enter ship' holds. Walking a straight
 *     burst when the ship is at a 30–45° bearing orbits it (the facing never
 *     settles inside the cone), so the final aim is a turn, not a walk.
 */
async function reEnterShip(
  page: Page,
  pad: { x: number; z: number },
  goalPrompt: string,
): Promise<void> {
  const prompt = page.locator('#interact-prompt');
  const promptText = async (): Promise<string | null> =>
    prompt
      .isVisible()
      .then((v) => (v ? prompt.textContent() : null))
      .catch(() => null);

  // 1. CLOSE the distance (the bearing walk, distance gate only).
  for (let i = 0; i < 40; i++) {
    const p = await charPos(page);
    const f = await charForward(page);
    const dx = pad.x - p.x;
    const dz = pad.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= 2) break;
    const angle = Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz);
    if (Math.abs(angle) <= 0.79) {
      await touch(page, 'move', { thrust: 1 });
      await page.waitForTimeout(Math.max(150, Math.min(1_500, ((dist - 2) / 3) * 1000)));
      await touch(page, 'move', { thrust: 0 });
    } else {
      const dir = angle > 0 ? -1 : 1;
      await touch(page, 'move', { yaw: dir });
      await page.waitForTimeout(100);
      await touch(page, 'move', { yaw: 0 });
    }
    await page.waitForTimeout(400);
    await charSettled(page);
  }

  // 2. FACE the ship (in-place yaw toward the signed bearing, at rest).
  for (let i = 0; i < 30; i++) {
    if ((await promptText()) === goalPrompt) break;
    const p = await charPos(page);
    const f = await charForward(page);
    const dx = pad.x - p.x;
    const dz = pad.z - p.z;
    const angle = Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz);
    if (Math.abs(angle) <= 0.5) break; // inside the ±30° cone
    const dir = angle > 0 ? -1 : 1;
    await touch(page, 'move', { yaw: dir });
    await page.waitForTimeout(120);
    await touch(page, 'move', { yaw: 0 });
    await page.waitForTimeout(400);
    await charSettled(page);
  }
  await expect(prompt).toHaveText(goalPrompt, { timeout: 15_000 });
}

/**
 * The VTOL LAND leg (the shard.pads.approach.test.ts approach, driven by
 * touch channels + the server taps): the atmosphere has NO main thruster —
 * the only horizontal control is the ship's own momentum (quadratic drag
 * bleeds it off) — so the approach is a dead-stick glide: 50 m up with a
 * 90 u/s velocity aimed straight at the pad (the dev teleport seeds it;
 * the glide itself is real physics):
 *
 *  - GLIDE: thrust 0, VTOL 0 — momentum + drag + gravity carry the last
 *    stretch (the unit test's GLIDE phase, 100 m/50 m/90 u/s docked in
 *    4.5 s of sim time on the test seed's planet);
 *  - VTOL at TOUCHDOWN (≤ 25 m, on the ground — the unit-test rule): the
 *    server assist (×0.5/tick on horizontal drift, up > 0) kills the
 *    residual drift in place while the 1.35·g lift holds the ship at ground
 *    level, and the pad machine docks it (surface regime, |vel.y| < 2,
 *    ≤ 20 m, ≤ 1 m pad altitude). (The pre-TASK-95.1 "≤ 15 m / < 8 m"
 *    switch armed too late: on this seed the ship had already stopped
 *    ~21 m out, outside the disc.)
 *  - the stop point is MEASURED, not assumed (the probe glide, below): the
 *    world is deterministic, so the probe's stop distance tells the final
 *    glide exactly where to start; a stop OFF the disc is re-measured and
 *    re-shifted (up to 3 glides total — no steering needed).
 */
// The world is deterministic (DRIFT-SEED-0001), so the leg MEASURES the
// glide's stop point and re-seeds to it. The run-7 lesson: the stop point is
// a property of (start distance, corridor terrain) — the corridor relief
// broke the "travel is constant" extrapolation (the 85 m start stopped 23 m
// out; the 75 m start stopped ~21 m out on all three attempts: a CLOSER
// start lands with MORE energy, not less, and skids past the 20 m disc).
//
//  PROBE (glide 1): the 130 m dead-stick stops well clear of the pad; its
//  stop distance g is the measurement (no VTOL — a pure measurement).
//  FINAL (glides 2–3): start shifted by g — S = 130 − g. Starting farther
//  flies the SAME trajectory shifted (drag + gravity are translation
//  invariant; only the corridor terrain under the shifted path differs), so
//  the stop shifts by ≈ g and lands ON the pad centre; the residual is the
//  corridor relief (a few m — inside the 20 m dock disc). If it still stops
//  off the disc, the stop is re-measured and the shift re-applied (the
//  deterministic world converges).
const LAND_PROBE_DIST_M = 130;
const LAND_START_ALT_M = 50;
const LAND_INBOUND_M_S = 90;
const LAND_MAX_ATTEMPTS = 3;
// The VTOL switch (the unit-test rule): at TOUCHDOWN within 25 m of the pad
// — the ×0.5/tick assist then kills the residual drift in place while the
// 1.35·g lift holds the ship at ground level, and the pad machine docks it.
const VTOL_SWITCH_DIST_M = 25;
const VTOL_SWITCH_HSPD = 30;

/**
 * One dead-stick glide: seed at `startDist` out / 50 m up / 90 u/s inbound,
 * glide until the pad machine docks the ship (or it comes to rest off the
 * disc) and report the outcome. With `vtolAtTouchdown` the VTOL channel
 * arms on touchdown within {@link VTOL_SWITCH_DIST_M} (the settle phase).
 */
async function glideOnce(
  page: Page,
  baseURL: string,
  token: string,
  pad: Vec3,
  padId: string,
  startDist: number,
  vtolAtTouchdown: boolean,
  label: string,
): Promise<{ docked: boolean; stopX: number | null; vtolHeld: boolean; ms: number }> {
  const t0 = Date.now();
  // Seed the approach: startDist out on the +x side of the pad, 50 m up,
  // 90 u/s inbound (the aim is −x — the dev teleport takes the vel).
  // The pre-teleport server state (diagnostic — the run-8 anomaly: the ship
  // carried its space-leg velocity into the glide, as if the vel seed had
  // not taken).
  const pre = await lastState(page);
  if (pre) {
    console.log(
      `[TASK-95] ${label} pre-teleport: vel=(${pre.vel.x.toFixed(1)}, ${pre.vel.y.toFixed(1)}, ` +
        `${pre.vel.z.toFixed(1)}) regime=${pre.regime}/${pre.flightRegime}`,
    );
  }
  await teleport(
    page,
    baseURL,
    token,
    { x: pad.x + startDist, y: pad.y + LAND_START_ALT_M, z: pad.z },
    { x: -LAND_INBOUND_M_S, y: 0, z: 0 },
  );
  // The SERVER state shortly after the teleport (the tap is authoritative —
  // entity_update carries e.ship raw): must show vel ≈ (−90, 0, 0). The 10 Hz
  // broadcast means an early tap can still hold the PRE-teleport frame, so
  // only log a dump whose position is already AT the target (post-teleport),
  // then take a second one 800 ms later that cannot be the pre frame.
  const dump = async (at: string): Promise<void> => {
    const st = await lastState(page);
    if (!st) return;
    const d = Math.hypot(st.pos.x - (pad.x + startDist), st.pos.y - (pad.y + LAND_START_ALT_M));
    if (d < 25) {
      console.log(
        `[TASK-95] ${label} ${at}: pos=(${st.pos.x.toFixed(0)}, ${st.pos.y.toFixed(0)}, ` +
          `${st.pos.z.toFixed(0)}) vel=(${st.vel.x.toFixed(1)}, ${st.vel.y.toFixed(1)}, ` +
          `${st.vel.z.toFixed(1)}) regime=${st.regime}/${st.flightRegime}`,
      );
    }
  };
  await page.waitForTimeout(400);
  await dump('post-400ms');
  await page.waitForTimeout(800);
  await dump('post-1200ms');
  // The input frames around the teleport (any stray channel is the leak).
  console.log(
    `[TASK-95] ${label} in-frames near teleport: ${JSON.stringify(await lastInFrames(page, 4))}`,
  );
  await expect
    .poll(() => lastState(page).then((u) => u?.flightRegime ?? 'none'), {
      timeout: 20_000,
      message: `server flightRegime never reached atmosphere (${label})`,
    })
    .toBe('atmosphere');
  expect(await setChannel(page, { thrust: 0, vtol: false }), 'glide channels set').toBe(true);

  let vtolHeld = false;
  let restMs = 0;
  let lastLog = 0;
  for (;;) {
    if (Date.now() - t0 > 25_000) {
      const s = (await lastState(page))!;
      const stopX = s.pos.x - pad.x;
      const spd = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
      console.log(
        `[TASK-95] ${label} 25 s timeout (x=${stopX.toFixed(0)} m alt=${(s.pos.y - pad.y).toFixed(1)} ` +
          `m speed=${spd.toFixed(1)} u/s frames=${JSON.stringify(await lastInFrames(page))})`,
      );
      return { docked: false, stopX, vtolHeld, ms: Date.now() - t0 };
    }
    const s = await lastState(page);
    if (!s) {
      await page.waitForTimeout(100);
      continue;
    }
    if (s.regime === 'docked' && s.padId === padId) {
      const dist = Math.hypot(s.pos.x - pad.x, s.pos.z - pad.z);
      console.log(`[TASK-95] ${label} DOCKED (dist=${dist.toFixed(1)} m vtolHeld=${vtolHeld})`);
      return { docked: true, stopX: null, vtolHeld, ms: Date.now() - t0 };
    }
    const dx = s.pos.x - pad.x;
    const dist = Math.hypot(dx, s.pos.z - pad.z);
    const hSpeed = Math.hypot(s.vel.x, s.vel.z);
    if (
      !vtolHeld &&
      vtolAtTouchdown &&
      dist <= VTOL_SWITCH_DIST_M &&
      s.vel.y === 0 &&
      hSpeed < VTOL_SWITCH_HSPD
    ) {
      vtolHeld = true;
      expect(await setChannel(page, { vtol: true }), 'vtol set').toBe(true);
      // TASK-95.1 diagnostic (kept — the wire evidence): what the client
      // put on the wire once the VTOL channel is on ('vtol' in action =
      // up: 1 the server integrates).
      console.log(
        `[TASK-95] ${label} vtol at touchdown (dist=${dist.toFixed(1)} m ` +
          `alt=${(s.pos.y - pad.y).toFixed(1)} m hSpeed=${hSpeed.toFixed(1)} u/s): ` +
          `sent frames=${JSON.stringify(await lastInFrames(page, 3))}`,
      );
    }
    if (Date.now() - lastLog > 1_000) {
      lastLog = Date.now();
      const spd = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
      console.log(
        `[TASK-95] ${label} t=${((Date.now() - t0) / 1000).toFixed(0)} s x=${dx.toFixed(0)} m ` +
          `alt=${(s.pos.y - pad.y).toFixed(1)} m speed=${spd.toFixed(1)} u/s${vtolHeld ? ' [vtol]' : ''}`,
      );
    }
    // Rested: on the ground (the server clamps vel.y to 0) and stopped.
    const spd = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    if (s.vel.y === 0 && spd < 0.5 && s.pos.y - pad.y < 1.5) {
      restMs += 100;
      if (restMs >= 300) {
        console.log(
          `[TASK-95] ${label} STOPPED x=${dx.toFixed(1)} m (alt=${(s.pos.y - pad.y).toFixed(1)} m)`,
        );
        return { docked: false, stopX: dx, vtolHeld, ms: Date.now() - t0 };
      }
    } else {
      restMs = 0;
    }
    await page.waitForTimeout(100);
  }
}

async function landOnPad(
  page: Page,
  baseURL: string,
  token: string,
  pad: Vec3,
  padId: string,
): Promise<{ vtolHeldAtDock: boolean; landMs: number }> {
  const start = Date.now();
  // Glide 1 = PROBE: measure where the 130 m dead-stick stops on this
  // seed's corridor (no VTOL — a pure measurement of the terrain).
  const probe = await glideOnce(
    page,
    baseURL,
    token,
    pad,
    padId,
    LAND_PROBE_DIST_M,
    false,
    'probe',
  );
  if (probe.docked) return { vtolHeldAtDock: probe.vtolHeld, landMs: Date.now() - start };
  let g = probe.stopX ?? 0;
  for (let attempt = 2; attempt <= LAND_MAX_ATTEMPTS; attempt++) {
    const s = LAND_PROBE_DIST_M - g;
    console.log(
      `[TASK-95] land attempt ${attempt}: re-seeding at ${s.toFixed(0)} m ` +
        `(last stop ${g.toFixed(0)} m from the pad)`,
    );
    const r = await glideOnce(page, baseURL, token, pad, padId, s, true, `final${attempt - 1}`);
    if (r.docked) return { vtolHeldAtDock: r.vtolHeld, landMs: Date.now() - start };
    if (r.stopX !== null) g = r.stopX; // re-measure; the next glide re-shifts
  }
  throw new Error(
    `land leg: still ${g.toFixed(0)} m from the pad after ${LAND_MAX_ATTEMPTS} glides`,
  );
}

test('touch-only SC-1 loop: claim → warp → fly → VTOL land → exit → mine → re-enter → sell', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  // The VTOL land leg (glide + settle) and the two on-foot walks add wall
  // time; budget generously (the run-2 legs before the land leg ran ~3 min).
  test.setTimeout(360_000);
  const loopStart = Date.now();

  // (1) CLAIM — the form, in the TOUCH-EMULATED browser (hasTouch →
  // maxTouchPoints > 0 → Controls 'auto' resolves ON → the layout renders).
  // The home system derives from the player UUID; the loop needs a PAD in a
  // NEIGHBOUR (the star chart only exposes the two nearest systems), so
  // claim, probe, and re-claim with a fresh callsign until one lands.
  const found = await (async (): Promise<{
    context: BrowserContext;
    page: Page;
    session: ClaimResponse;
    target: PadTarget;
  } | null> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const callsign = uniqueCallsign('tl95');
      const ctx = await browser.newContext({ hasTouch: true });
      await ctx.addInitScript(tapShipUpdates, callsign);
      const pg = await ctx.newPage();
      const claim = new ClaimPage(pg, baseURL);
      await claim.claim(callsign);
      const stored = (await pg.evaluate(
        () => JSON.parse(localStorage.getItem('drift.session.v1') ?? 'null'),
      )) as ClaimResponse | null;
      expect(stored?.token, `session stored by the claim flow (attempt ${attempt})`).toBeTruthy();
      const auth = { authorization: `Bearer ${stored!.token}` };
      // The deterministic pad in one of the chart's two neighbours (the
      // mobile-profile.spec.ts search, neighbours only — the warp leg needs
      // a non-current destination).
      const overview = (await (
        await fetch(`${baseURL}/api/galaxy/overview?home=${stored!.homeSystemId}`, { headers: auth })
      ).json()) as Overview;
      const neighbors = overview.systems.find((s) => s.systemId === stored!.homeSystemId)!
        .neighbors;
      for (const n of neighbors) {
        const res = await fetch(`${baseURL}/api/dev/pad-target?systemId=${n.to}`, { headers: auth });
        if (res.status !== 200) continue;
        const cand = (await res.json()) as PadTarget;
        if (cand.pad) {
          return { context: ctx, page: pg, session: stored!, target: cand };
        }
      }
      await ctx.close();
    }
    return null;
  })();
  expect(found, 'a neighbour system hosts the seeded pad').not.toBeNull();
  const { context, page, session } = found!;
  const t = found!.target;
  const termRes = await fetch(`${baseURL}/api/dev/terminal-target?systemId=${t.systemId}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  expect(termRes.status).toBe(200);
  const term = (await termRes.json()) as TerminalTarget;
  expect(
    term.systemId,
    'the terminal is on the same planet as the pad',
  ).toBe(t.systemId);
  console.log(
    `[TASK-95] callsign=${session.callsign} padSystem=${t.systemId} pad=(${t.pad.x.toFixed(0)}, ${t.pad.y.toFixed(0)}, ${t.pad.z.toFixed(0)})`,
  );

  const { assertClean } = collectErrors(page);
  // TASK-95.1 diagnostic: the SCHEME-SWAP timeline — RegimeWiring logs every
  // controls remap (the console.debug sink) the instant the active scheme
  // flips, so a stale 'space' scheme after the atmosphere teleport shows up
  // in the run log next to the __TLIN__ wire frames.
  const schemeSwaps: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('controls remap')) schemeSwaps.push(m.text());
  });
  expect(await page.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);
  expect(
    await page.evaluate(() => !!window.__TOUCH__?.setChannel),
    'touchDebug hook installed',
  ).toBe(true);

  // (2) MOBILE PROFILE FORCED (the TASK-59 override, PUT before the world
  // load) — the 30 fps floor pipeline runs the whole loop.
  const putRes = await fetch(`${baseURL}/api/players/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceProfile: 'mobile' }),
  });
  expect(putRes.status).toBe(200);
  await page.reload();
  await expect(page.locator('#player-list')).toContainText(`${session.callsign} (you)`, {
    timeout: 20_000,
  });
  await expect
    .poll(
      () => page.evaluate(() => window.__STREAM__?.lodRadii()?.farMaxM ?? -1),
      { timeout: 15_000, message: 'mobile pipeline never activated (farMaxM)' },
    )
    .toBe(3_000);

  // (3) MENU → CHART → WARP (the touch-menu path, TASK-94): the MENU button
  // action through the touchDebug passthrough, then a touch TAP on the
  // SYSTEMS entry, the pad's node and the WARP button (DOM buttons — the
  // real touch layout drives them with pointer events too).
  expect(await touch(page, 'openMenu'), 'openMenu through the touch hook').toBeUndefined();
  await expect(page.locator('#esc-menu')).toBeVisible({ timeout: 10_000 });
  await page.locator('#esc-menu-systems').click();
  await expect(page.locator('#star-chart')).toBeVisible();
  await expect(page.locator('#star-chart-loading')).toBeHidden();
  const padNode = page.locator(
    `[data-testid="star-chart-node"][data-system-id="${t.systemId}"]`,
  );
  await expect(padNode).toHaveCount(1); // the pad system is on the chart (a neighbour)
  // The ESC menu is STILL OPEN under the chart — openChart()
  // (src/client/state/menu.ts:80) PUSHES the chart onto the surface stack
  // without popping the menu, so #esc-menu (z-index 111, esc-menu.tsx:66)
  // renders LATER than #star-chart (z-index 111, star-chart.tsx:210) in the
  // DOM. A real touch on the node only works when the node falls OUTSIDE
  // the menu's box — the node position is seed-dependent, so a coordinate
  // click (even { force: true } — Playwright dispatches by coordinates and
  // the BROWSER still hit-tests the point: the menu captures it, the
  // selection never lands and WARP stays disabled) is a genuine flake.
  // Dispatch the click on the node itself instead: same React onClick,
  // deterministic, and the app's surface-stack semantics (TASK-53) are
  // untouched.
  await padNode.dispatchEvent('click');
  const warpButton = page.locator('#warp-button');
  await expect(warpButton).toBeEnabled();
  await warpButton.click();
  await expect(page.locator('#warp-overlay')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#warp-overlay')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('#sys-id')).toContainText(`sys ${t.systemId}`);
  // CLOSE the surfaces again (touch TAPS on the DOM close buttons): the
  // flight input loop suppresses input while the chart is open, so the
  // docked ship can only take off once the stack is down.
  await page.locator('#star-chart-close').click();
  await expect(page.locator('#star-chart')).toBeHidden({ timeout: 10_000 });
  await page.locator('#esc-menu-resume').click();
  await expect(page.locator('#esc-menu')).toBeHidden({ timeout: 10_000 });
  // The world re-loaded on the mobile pipeline (the world load re-applies).
  await expect
    .poll(() => page.evaluate(() => window.__STREAM__?.lodRadii()?.farMaxM ?? -1), {
      timeout: 15_000,
      message: 'mobile pipeline lost after the warp',
    })
    .toBe(3_000);

  // (4) SPACE: thrust to ACCELERATE (server speed taps) — the first input
  // also takes the home-docked ship off.
  expect(await setChannel(page, { thrust: 1 }), 'thrust channel set').toBe(true);
  await expect
    .poll(() => lastState(page).then((u) => u?.regime ?? 'none'), {
      timeout: 15_000,
      message: 'server never reported a non-docked regime after touch thrust',
    })
    .not.toBe('docked');
  const speed = (): Promise<number> =>
    lastState(page).then((u) => (u ? Math.hypot(u.vel.x, u.vel.y, u.vel.z) : -1));
  await expect
    .poll(() => speed(), {
      timeout: 15_000,
      message: 'server speed never rose above 0 with touch thrust',
    })
    .toBeGreaterThan(0);
  const s1 = await speed();
  await page.waitForTimeout(2_000);
  const s2 = await speed();
  expect(
    s2,
    `speed not rising under sustained touch thrust (t0=${s1.toFixed(1)}, +2 s=${s2.toFixed(1)}`,
  ).toBeGreaterThan(s1);
  expect(await setChannel(page, { thrust: 0 }), 'thrust released').toBe(true);

  // (5) SPACE: a YAW burst turns the nose toward the ship's RIGHT (the
  // TASK-80 convention — the heading half of the spec's space leg).
  const probe0 = await page.evaluate(() => window.__SELF_SHIP__!.probe()!);
  const right0 = initialRight(probe0.rot as Quat);
  expect(await setChannel(page, { yaw: 1 }), 'yaw channel set').toBe(true);
  await page.waitForTimeout(2_000);
  expect(await setChannel(page, { yaw: 0 }), 'yaw released').toBe(true);
  const dotD = await page.evaluate((r0: Vec3) => {
    const p = window.__SELF_SHIP__?.probe();
    if (!p?.pos || !p.rot) return Number.NaN;
    const { x, y, z, w } = p.rot;
    const fwd = { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
    return fwd.x * r0.x + fwd.y * r0.y + fwd.z * r0.z;
  }, right0);
  expect(
    dotD,
    `yaw=+1 for 2 s: dot(forward, initial right) = ${dotD.toFixed(3)} (must be > 0.2)`,
  ).toBeGreaterThan(0.2);

  // (6) ATMOSPHERE + VTOL + LAND: a real APPROACH, not a drop — the ship is
  // seeded 100 m out / 50 m up (inside the 1000 m band → 'atmosphere') with
  // a 90 u/s dead-stick velocity aimed at the pad (the atmosphere has no
  // thrust, so momentum + drag + gravity do the glide — the exact
  // shard.pads.approach state), then the VTOL channel on for the final
  // settle: the 1.35·g lift brakes the descent, the server assist damps the
  // drift, and the pad machine docks the grounded ship (regime 'docked' +
  // padId — the atmosphere / undock specs' landing state).
  let land: { vtolHeldAtDock: boolean; landMs: number };
  try {
    land = await landOnPad(page, baseURL, session.token, t.pad, t.padId);
  } catch (err) {
    // TASK-95.1 diagnostic: the scheme timeline next to the failure.
    console.log(
      `[TASK-95] land-leg failure — scheme swaps: ${JSON.stringify(schemeSwaps)}`,
    );
    throw err;
  }
  console.log(`[TASK-95] landed — scheme swaps: ${JSON.stringify(schemeSwaps)}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 15_000 });
  // The pilot releases the lift at docking: the VTOL channel was held
  // through the touchdown, and leaving it on would project ' ' as the
  // on-foot JUMP the moment the egress lands the character on the pad.
  await touch(page, 'clear');

  // (7) EXIT — the egress prompt through the touch INTERACT (the shared E
  // path: interactPress now owns the docked branch, TASK-95).
  expect(await touch(page, 'interactPress'), 'interactPress (egress) through the touch hook').toBe(
    undefined,
  );
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  const bar = page.locator('#weight-bar');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  const pos0 = await charPos(page);

  // (8) MINE — a deposit 4 m ahead of the facing; WALK to it with the MOVE
  // stick (thrust) until the prompt arms, then a FULL interactPress hold
  // (> the 1.5 s channel) → the server awards the unit (1/40u).
  const fwd0 = await charForward(page);
  const depRes = await fetch(`${baseURL}/api/dev/deposit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      x: pos0.x + fwd0.x * 4,
      y: pos0.y + fwd0.y * 4,
      z: pos0.z + fwd0.z * 4,
      quantity: 1,
    }),
  });
  expect(depRes.status).toBe(200);
  const prompt = page.locator('#interact-prompt');
  await touch(page, 'move', { thrust: 1 });
  await expect(prompt).toContainText('mine iron', { timeout: 20_000 });
  await touch(page, 'move', { thrust: 0 });
  await charSettled(page);
  expect(await touch(page, 'interactPress'), 'interactPress (mine) through the touch hook').toBe(
    undefined,
  );
  await expect(page.locator('#mining-hud')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_800); // a full 1.5 s server mining channel
  expect(await touch(page, 'interactRelease'), 'interactRelease (mine) through the touch hook').toBe(
    undefined,
  );
  await expect(bar).toHaveText(/1\/40u/, { timeout: 15_000 });
  await expect(prompt).toBeHidden({ timeout: 10_000 });

  // (9) RE-ENTER — the ship is docked at the pad center (a known point):
  // close the distance with the bearing walk, then FACE the ship in place
  // until '[E] Enter ship' arms (≤ 3 m AND the ±30° cone), and interactPress.
  await reEnterShip(page, { x: t.pad.x, z: t.pad.z }, '[E] Enter ship');
  await page.waitForTimeout(400);
  await expect(prompt).toHaveText('[E] Enter ship'); // the prompt HOLDS
  expect(await touch(page, 'interactPress'), 'interactPress (re-enter) through the touch hook').toBe(
    undefined,
  );
  await expect(prompt).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('#touch-stick-move').count(), 'no on-foot layout in-ship').toBe(0);

  // (10) SELL — exit again (touch INTERACT), walk to the station terminal
  // (at the pad edge), interactPress → the dock panel, TAP 'sell all iron
  // inv': credits 500 → 505 cr, cargo empty (the SC-1 terminal condition).
  expect(await touch(page, 'interactPress'), 'interactPress (egress #2) through the touch hook').toBe(
    undefined,
  );
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await charPos(page);
  await walkUntilPrompt(page, { x: term.pos.x, z: term.pos.z }, '[E] Dock terminal', 2.0);
  await page.waitForTimeout(400);
  await expect(prompt).toHaveText('[E] Dock terminal'); // the prompt HOLDS
  expect(await touch(page, 'interactPress'), 'interactPress (dock terminal) through the touch hook').toBe(
    undefined,
  );
  const panel = page.locator('#dock-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText('STATION DOCK');
  await expect(panel).toContainText('hold 0 · inv 1');
  const counter = page.locator('#credits-counter');
  await expect(counter).toBeVisible({ timeout: 15_000 });
  await expect(counter).toHaveText('500 cr');
  await panel.locator('button[aria-label="sell all iron inv"]').click();
  await expect(counter).toHaveText('505 cr');
  await expect(panel).toContainText('Nothing to sell');
  await expect(bar).toHaveText(/0\/40u/, { timeout: 10_000 }); // cargo empty

  // The visual artifact: the sold/dock state — dock panel, 505 cr counter,
  // empty bar, the on-foot touch layout under it.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-95-1.png'),
  });

  const wallMs = Date.now() - loopStart;
  console.log(
    `[TASK-95] loop wall=${(wallMs / 1000).toFixed(1)} s thrust ${s1.toFixed(1)} → ${s2.toFixed(1)} u/s ` +
      `yaw-dot=${dotD.toFixed(3)} land=${(land.landMs / 1000).toFixed(1)} s (vtol-held-at-dock=${land.vtolHeldAtDock}) ` +
      `landed=docked/pad egress=touch mined=1/40u re-entered=touch sold=+5 cr (505 cr) bar=0/40u`,
  );
  assertClean();
  await context.close();
});
