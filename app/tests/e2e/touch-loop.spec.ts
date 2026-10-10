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
 *  (4) enter the atmosphere above the seeded pad and LAND: VTOL lift is
 *      server-confirmed, release → gravity descent → the pad machine docks
 *      the ship (regime 'docked' + padId — the atmosphere / undock specs'
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
  regime: string;
  padId?: string;
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
  const w = window as unknown as { __TL__?: Tap[] };
  w.__TL__ = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
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
              regime: e.regime ?? 'space',
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

/** Dev-teleport the ship, then wait until the RENDERED ship is there. */
async function teleport(page: Page, baseURL: string, token: string, to: Vec3): Promise<void> {
  const res = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: to,
  });
  expect(res.status(), `teleport response: ${await res.text()}`).toBe(200);
  await expect
    .poll(
      () =>
        page.evaluate((t: Vec3) => {
          const p = window.__SELF_SHIP__?.probe()?.pos;
          return p ? Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) : 1e9;
        }, to),
      { timeout: 20_000, message: `rendered ship never reached ${JSON.stringify(to)}` },
    )
    .toBeLessThan(50);
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

test('touch-only SC-1 loop: claim → warp → fly → VTOL land → exit → mine → re-enter → sell', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(300_000);
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
  await padNode.click();
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

  // (6) ATMOSPHERE + VTOL + LAND: 60 m straight above the pad (inside the
  // 1000 m band → 'atmosphere', the planet-approach pattern). VTOL lift is
  // server-confirmed (the 1.35×g margin, TASK-86), then release → gravity
  // descent → the pad machine docks the ship on the pad disc (regime
  // 'docked' + padId — the atmosphere / undock specs' landing state).
  await teleport(page, baseURL, session.token, { x: t.pad.x, y: t.pad.y + 60, z: t.pad.z });
  await expect
    .poll(() => lastState(page).then((u) => u?.regime ?? 'none'), {
      timeout: 20_000,
      message: 'server regime never reached atmosphere after the approach teleport',
    })
    .toBe('atmosphere');
  const lift = (await lastState(page))!;
  expect(await setChannel(page, { vtol: 1 }), 'vtol channel set').toBe(true);
  await expect
    .poll(() => lastState(page).then((u) => u?.vel.y ?? 0), {
      timeout: 15_000,
      message: 'server vel.y never went positive with touch VTOL in atmosphere',
    })
    .toBeGreaterThan(2);
  await expect
    .poll(() => lastState(page).then((u) => u?.pos.y ?? 0), {
      timeout: 15_000,
      message: 'altitude never gained with touch VTOL in atmosphere',
    })
    .toBeGreaterThan(lift.pos.y + 5);
  // Release: gravity descent (the VTOL-landed ship comes DOWN without lift).
  const vtolTop = (await lastState(page))!;
  expect(await setChannel(page, { vtol: 0 }), 'vtol released').toBe(true);
  await expect
    .poll(() => lastState(page).then((u) => u?.pos.y ?? 1e9), {
      timeout: 20_000,
      message: 'altitude never dropped after releasing touch VTOL',
    })
    .toBeLessThan(vtolTop.pos.y - 10);
  // The pad machine docks the settled ship (findPad: on the pad disc, slow).
  await expect
    .poll(
      () =>
        lastState(page).then((u) => (u?.regime === 'docked' && u.padId === t.padId ? 'docked' : u?.regime ?? 'none')),
      { timeout: 30_000, message: 'server never docked the ship on the pad after the VTOL descent' },
    )
    .toBe('docked');
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 15_000 });

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

  // (9) RE-ENTER — steer back to the ship (docked at the pad center) with
  // the prompt-as-sensor loop, then interactPress at '[E] Enter ship'.
  await walkUntilPrompt(page, { x: t.pad.x, z: t.pad.z }, '[E] Enter ship', 1.8);
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
      `yaw-dot=${dotD.toFixed(3)} vtol-lift vel.y>2 (alt ${lift.pos.y.toFixed(0)} → ${vtolTop.pos.y.toFixed(0)}) ` +
      `landed=docked/pad egress=touch mined=1/40u re-entered=touch sold=+5 cr (505 cr) bar=0/40u`,
  );
  assertClean();
  await context.close();
});
