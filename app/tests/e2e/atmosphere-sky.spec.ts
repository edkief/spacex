import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasRegionStats, collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';
// The e2e process re-derives the seeded galaxy with the SAME shared code the
// server uses (relative imports — the Playwright runner does not resolve the
// tsconfig aliases), so no seed value is hardcoded in this spec.
import { planetAnchor, planetAtmosphereDensity } from '../../src/shared/galaxy/planets';
import { CHUNK_SIZE, CELL_SIZE_M, generateSurfaceChunk } from '../../src/shared/galaxy/surface';
import { generateStars } from '../../src/shared/galaxy/stars';
import { generateSystem } from '../../src/shared/galaxy/system';
import type { Planet } from '../../src/shared/galaxy/types';
import { padsForSystem } from '../../src/shared/world/pads';

/**
 * TASK-76 — E2E regression: inside an atmosphere, low and OFF-CENTRE, the
 * sky is the dome — and the camera's far plane must reach the dome's far
 * wall.
 *
 * The TASK-28.1 crossfade fades the skybox + stars OUT as haze rises
 * (opacity = 1 - haze) and the atmosphere dome (a BackSide sphere of
 * radius 1000 × 1.01 u centred on the planet anchor) paints the sky
 * instead. But the old camera far plane was 1000 u: from anywhere but
 * the dome's exact centre the far wall is farther than that (up to
 * 2 × 1010 u), so the part of the dome beyond the far plane was clipped
 * and the black clear color showed through the nearly-transparent sky.
 *
 * Target choice — why the DENSEST atmospheric planet, not the home pad:
 * pre-fix, the clipped region shows the skybox at opacity (1 − haze) over
 * the black clear, so the top band reads
 *   mean ≈ (1 − haze) × skyLuminance,  haze = (1 − alt/1000) × density/0.1.
 * A thin-atmosphere pad (the home system's ~0.06) caps the haze at ~0.4 —
 * the band still reads ~20+, at or above the "clipped cap" threshold of
 * 20, and the bug is invisible. The densest seeded planet (density → 0.1)
 * is the strongest contrast available: measured on DRIFT-SEED-0001 (this
 * spec's fixed seed), the pad sits at world y≈229 — the shared hazeFactor
 * uses WORLD-y altitude, not local altitude — so at the 60 u LOCAL spot
 * the haze is ≈ 0.58: pre-fix the whole band (aimed inside the clipped
 * cap) reads ≈ 11-13 and the assertion (mean > 20) fails; post-fix the
 * dome haze paints it at ≈ 66 and it passes. (Threshold per the TASK-76.1
 * escalation, option A: ≤ 5 is unreachable at this seed — the clip reads
 * (1−0.58)×skyLum, not black.) The scan is a pure function of the seed, so
 * the spec stays deterministic for whatever galaxy the server runs.
 *
 * Flow: raw REST claim → raw WS warp straight to that system (the
 * pvp-kill.spec.ts pattern — the router validates the warp target only
 * against the seed, not against the chart's neighbor list) → the browser
 * joins it with ?sys= → dev-teleport 600 u off the dome anchor at 60 u
 * LOCAL altitude → aim the nose at the dome centre (anchor.x, 0,
 * anchor.z — ~26° down, so the whole band sits inside the clipped cap)
 * → assert the central top band's mean luminance > 20.
 */

/** Mirrors src/server/env.ts — the e2eServer fixture never overrides the seed. */
const SEED = 'DRIFT-SEED-0001';
const PROTOCOL_VERSION = 1; // mirrors @shared/protocol

/**
 * The blackout band: a CENTRAL strip of the top 30 % (x 0.35-0.65), above
 * the ship. Why central and not full-width: pre-fix, with a LEVEL aim, the
 * clipped dome cap (the dark region) sits in the view centre, offset below
 * a bright-blue ring of the VISIBLE part of the dome (within the 1000 u
 * far plane) that reaches the corners — a full-width band averages in that
 * ring and reads bright even while the bug is present. The aim pitches the
 * nose at the dome centre, so the whole central strip sits inside the
 * clipped cap (cap ~63° around the boresight; the strip spans 0-37.5°):
 * pre-fix it shows the partly-faded skybox over the black clear
 * (luminance ~11-13 at haze ≈ 0.58, assertion fails) and post-fix the
 * full dome haze (luminance ~66, passes). The ship sits at ~y 0.6, the
 * terrain at the bottom, so the top strip is clear of both.
 */
const TOP_BAND = { x0: 0.35, y0: 0, x1: 0.65, y1: 0.3 };
/** Full-width top band, logged (not asserted) to record the ring's effect. */
const FULL_TOP_BAND = { x0: 0, y0: 0, x1: 1, y1: 0.3 };
/** Offsets from the pad, nearest to farthest (the dome anchor sits ~260 u off the pad). */
const OFFSETS = [600, 450, 300, 150];
/** Teleport altitude above the LOCAL terrain (u) — the AC's "60 u altitude". */
const ALT_OFFSET_U = 60;

interface Session {
  token: string;
  callsign: string;
  homeSystemId: string;
}

interface ShipUpdate {
  pos: { x: number; y: number; z: number };
  /** Flight regime inside sublight: 'space' | 'atmosphere' | 'surface'. */
  flightRegime: string;
}

/** The densest landable+atmospheric pad in the seeded galaxy (star order scan). */
function densestAtmosphericPad(seed: string): {
  systemId: string;
  planet: Planet;
  planetIndex: number;
  pad: { x: number; y: number; z: number };
  density: number;
} {
  let best: ReturnType<typeof densestAtmosphericPad> | null = null;
  for (const star of generateStars(seed)) {
    const system = generateSystem(seed, star.id);
    system.planets.forEach((planet, planetIndex) => {
      if (!planet.landable || !planet.hasAtmosphere) return;
      const pad = padsForSystem(seed, system).find((p) => p.planetId === planet.id);
      if (!pad) return;
      const density = planetAtmosphereDensity(planet);
      if (!best || density > best.density) {
        best = { systemId: system.systemId, planet, planetIndex, pad: pad.pos, density };
      }
    });
  }
  if (!best) throw new Error('no landable atmospheric planet in the seeded galaxy');
  return best;
}

/**
 * Terrain height at a world position (the same planet-wide field pads.ts
 * samples for the pad height) — lets the spec teleport at an exact LOCAL
 * altitude regardless of where the terrain undulates.
 */
function terrainY(seed: string, planet: Planet, x: number, z: number): number {
  const cellX = Math.floor(x / CELL_SIZE_M);
  const cellZ = Math.floor(z / CELL_SIZE_M);
  const cX = Math.floor(cellX / CHUNK_SIZE);
  const cZ = Math.floor(cellZ / CHUNK_SIZE);
  const chunk = generateSurfaceChunk(seed, planet, cX, cZ);
  return chunk.heightmap[(cellZ - cZ * CHUNK_SIZE) * CHUNK_SIZE + (cellX - cX * CHUNK_SIZE)];
}

/** Raw REST claim (the shape the browser claim flow stores). */
async function claim(baseURL: string, callsign: string): Promise<Session> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  const body = await res.text();
  expect(res.status, `claim: ${body}`).toBe(201);
  return JSON.parse(body) as Session;
}

/**
 * Warp the ship to `targetSystemId` via raw WS (join home → warp →
 * warp_arrived), then close — the ship ROW stays in the target system
 * while the browser joins it (the pvp-kill.spec.ts pattern).
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

/**
 * Tap the page's WebSocket (init script, flight.spec.ts pattern) so every
 * entity_update carrying OUR ship lands in window.__shipUpdates.
 */
function installShipTap(callsign: string): void {
  const w = window as unknown as { __shipUpdates?: ShipUpdate[] };
  w.__shipUpdates = [];
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
                kind?: string;
                callsign?: string;
                pos?: ShipUpdate['pos'];
                flightRegime?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e?.pos) {
            w.__shipUpdates?.push({ pos: e.pos, flightRegime: e.flightRegime ?? '' });
          }
        } catch {
          // never break the page's networking from a tap
        }
      });
    }
  };
}

test('inside atmosphere, low and off-centre: the top band shows haze, never black', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);

  // The repro target: the densest seeded atmosphere (haze → max at 60 u).
  const target = densestAtmosphericPad(SEED);
  console.log(
    `[TASK-76] target system=${target.systemId} density=${target.density.toFixed(4)} ` +
      `pad=(${target.pad.x.toFixed(0)}, ${target.pad.y.toFixed(1)}, ${target.pad.z.toFixed(0)})`,
  );

  const callsign = uniqueCallsign('atmosky');
  // Claim + warp BEFORE the browser: the ship row moves to the target
  // system (gate pose, flying) and the browser adopts it on join.
  const session = await claim(baseURL, callsign);
  await warpShip(apiPort, session, target.systemId);

  const context = await browser.newContext();
  // The tap must see the session WS from first open — install it pre-navigation.
  await context.addInitScript(installShipTap, callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (TASK-72 hook): the self ship projects in front.
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  const auth = { authorization: `Bearer ${session.token}` };
  const anchor = planetAnchor(target.planetIndex); // dome centre (the pad sits ~260 u off it)

  // Teleport 600 u off the pad at 60 u LOCAL altitude — inside the dome,
  // high haze, far wall ~1.8 km away. Poll until the rendered ship is
  // there AND the server regime is 'atmosphere'; if a smaller offset is
  // needed to stay inside, reduce it (per spec).
  let usedOffset = -1;
  let lastRegime = '';
  let spot = { x: 0, y: 0, z: 0 };
  const state = (t: {
    x: number;
    y: number;
    z: number;
  }): Promise<{
    near: boolean;
    regime: string;
  }> =>
    page.evaluate((tg: { x: number; y: number; z: number }) => {
      const p = window.__SELF_SHIP__?.probe()?.pos;
      const near = !!p && Math.hypot(p.x - tg.x, p.y - tg.y, p.z - tg.z) < 50;
      const updates = (window as unknown as { __shipUpdates?: ShipUpdate[] }).__shipUpdates;
      return { near, regime: updates?.at(-1)?.flightRegime ?? '' };
    }, t);
  for (const offset of OFFSETS) {
    spot = {
      x: target.pad.x + offset,
      y: terrainY(SEED, target.planet, target.pad.x + offset, target.pad.z) + ALT_OFFSET_U,
      z: target.pad.z,
    };
    const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
      headers: { ...auth, 'content-type': 'application/json' },
      data: spot,
    });
    expect(tele.status(), `teleport response: ${await tele.text()}`).toBe(200);
    // Manual deadline loop (expect.poll is not thenable): the rendered ship
    // must arrive within 50 u AND the server regime must be 'atmosphere'.
    let ok = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const v = await state(spot);
      lastRegime = v.regime || lastRegime;
      if (v.near && v.regime === 'atmosphere') {
        ok = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (ok) {
      usedOffset = offset;
      break;
    }
  }
  expect(
    usedOffset,
    `ship never reached atmosphere regime (last server regime: ${lastRegime})`,
  ).toBeGreaterThan(0);

  // --- Aim the nose at the dome CENTRE ----------------------------------
  // The dome is a BackSide sphere centred on (anchor.x, 0, anchor.z) — the
  // anchor has no y; WorldManager.setAtmosphereView pins the dome mesh to
  // y=0 while the surface sits ~230 u up. Pre-fix the clipped cap is the
  // far part of the dome, i.e. along the ANCHOR direction: at this spot the
  // dome centre sits ~26° BELOW a level boresight, so a level aim covers
  // only the cap's lower half and the band's top third stays over the
  // visible (bright) dome. Aiming at the dome CENTRE (yaw + pitch-down)
  // puts the WHOLE band inside the clipped cap (cap ~63° around a direction
  // 26° down; the band spans only 0-37.5° of the boresight). Per the
  // TASK-76.1 escalation (option A) the pre-fix AC is "band ≤ 20": the
  // seed's haze here is ≈ 0.58 — the shared hazeFactor uses WORLD-y
  // altitude, and this pad sits at y≈229 — so the cap reads ~11-13
  // (skybox at opacity 1-0.58 over the black clear), never ≤ 5; post-fix
  // the dome haze reads ~66.
  //
  // Closed-loop yaw + pitch on the world boresight. Deterministic (the old
  // loop held `w` + a fixed 14 iterations and once ended 174.7° off):
  // (a) NO thrust held — the server applies `input.yaw * turnRate * h` and
  //     `input.pitch * turnRate * h` unconditionally (integrateStep in
  //     @shared/physics/flight), so `w` only couples thrust/drag into the
  //     attitude. The ship must NOT fall: full VTOL demand (`space`)
  //     outruns gravity (TASK-86: VTOL_LIFT = 1.35×GRAVITY), so it can't
  //     sink — it CLIMBS a few u/s during the aim (the closed loop tracks
  //     the dome centre as the boresight changes), and the atmosphere
  //     control scheme (which has live yaw AND pitch, unlike the surface
  //     scheme's `yaw: null`) stays usable for the whole aim. The re-pin
  //     teleport below restores the exact spot.
  // (b) A wall-clock deadline (not a fixed iteration count): each
  //     iteration probes the yaw + pitch errors and presses the yaw and/or
  //     pitch keys for a duration proportional to |err|.
  // (c) Convergence is HARD-ASSERTED (both axes) before anything is
  //     measured — a mis-aimed run must fail loudly, not silently read the
  //     band.
  // The 'd'/'a' and 'r'/'f' signs are each calibrated empirically with one
  // 120 ms press (no assumption about the flight model's rotation signs),
  // also without `w`.
  const AIM_DEADLINE_MS = 18_000;
  const AIM_TOLERANCE_RAD = 0.12; // the hard assertion (spec)
  const AIM_SETTLE_RAD = 0.05; // internal exit threshold — leaves tick-overshoot margin
  const TURN_RATE_RAD_S = 0.8; // scout (the claim's default class) — fallback rate
  const domeCentre = { x: anchor.x, y: 0, z: anchor.z }; // the dome mesh centre
  const aimProbe = (): Promise<{
    yawErr: number;
    pitchErr: number;
    h: number;
    noseElev: number;
  } | null> =>
    page.evaluate((t: { x: number; y: number; z: number }) => {
      const p = (
        window as unknown as {
          __SELF_SHIP__?: {
            probe: () => {
              pos: { x: number; y: number; z: number } | null;
              rot: { x: number; y: number; z: number; w: number } | null;
            };
          };
        }
      ).__SELF_SHIP__?.probe();
      const rot = p?.rot;
      const pos = p?.pos;
      // Non-finite (or absent) pose = "probe lost the ship": the caller
      // retries until the deadline instead of steering on a NaN error.
      if (!rot || !pos) return null;
      if (!Number.isFinite(rot.x + rot.y + rot.z + rot.w + pos.x + pos.y + pos.z)) {
        return null;
      }
      // Ship nose = local +Z under the ship quat (pose-math convention).
      const nx = 2 * (rot.x * rot.z + rot.y * rot.w);
      const ny = 2 * (rot.y * rot.z - rot.x * rot.w);
      const nz = 1 - 2 * (rot.x * rot.x + rot.y * rot.y);
      const dx = t.x - pos.x;
      const dy = t.y - pos.y;
      const dz = t.z - pos.z;
      // Both errors in one frame: the world heading and world elevation
      // the nose must gain to look at the dome centre.
      let yawErr = Math.atan2(dz, dx) - Math.atan2(nz, nx);
      while (yawErr > Math.PI) yawErr -= 2 * Math.PI;
      while (yawErr < -Math.PI) yawErr += 2 * Math.PI;
      const clampN = Math.max(-1, Math.min(1, ny));
      const pitchErr = Math.atan2(dy, Math.hypot(dx, dz)) - Math.asin(clampN);
      return { yawErr, pitchErr, h: Math.atan2(nz, nx), noseElev: Math.asin(clampN) };
    }, domeCentre);
  const press = async (keys: string[], ms: number): Promise<void> => {
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(ms);
    for (const k of keys) await page.keyboard.up(k);
  };
  // VTOL for the whole aim (see (a)): the lift (1.35×g, TASK-86) outruns
  // gravity, so the ship never lands and both rotation axes stay live (it
  // climbs during the aim; the re-pin below restores the exact spot).
  await page.keyboard.down(' ');
  // Each 120 ms calibration press doubles as a RATE calibration: the server
  // holds the last input frame and picks key events up at the 20 Hz tick
  // (≤ 50 ms each end), so a press of `ms` actually rotates the ship by
  // rate × (ms + δ) with δ ∈ [0, ~100 ms] — a press timed against the raw
  // 0.8 rad/s turn rate therefore overshoots by the constant rate×δ and
  // limit-cycles at ~±9°. Calibrating the EFFECTIVE rate per axis
  // (|Δ| / 0.12) absorbs δ into the number the proportional formula uses.
  const CALIBRATION_PRESS_S = 0.12;
  let dSign = 1; // +1 = 'd' increases the wrapped heading
  let rateYaw = TURN_RATE_RAD_S;
  let a = await aimProbe();
  if (a && Math.abs(a.yawErr) >= 0.15) {
    await press(['d'], 120);
    const b = await aimProbe();
    if (a && b) {
      let dh = b.h - a.h;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      dSign = dh >= 0 ? 1 : -1;
      if (Math.abs(dh) > 1e-4) rateYaw = Math.abs(dh) / CALIBRATION_PRESS_S;
    }
  }
  // Calibrate the 'r' pitch sign the same way: one press, measure how the
  // nose's world elevation moved (and the effective rate).
  let rSign = 1; // +1 = 'r' raises the nose's world elevation
  let ratePitch = TURN_RATE_RAD_S;
  const p0 = await aimProbe();
  await press(['r'], 120);
  const p1 = await aimProbe();
  if (p0 && p1) {
    const dn = p1.noseElev - p0.noseElev;
    if (Math.abs(dn) > 1e-4) {
      rSign = dn >= 0 ? 1 : -1;
      ratePitch = Math.abs(dn) / CALIBRATION_PRESS_S;
    }
  }
  const aimDeadline = Date.now() + AIM_DEADLINE_MS;
  while (Date.now() < aimDeadline) {
    a = await aimProbe();
    if (!a) {
      // Probe lost the ship (transient): wait for the next render frame,
      // never steer on a missing/NaN readout.
      await page.waitForTimeout(100);
      continue;
    }
    if (Math.abs(a.yawErr) < AIM_SETTLE_RAD && Math.abs(a.pitchErr) < AIM_SETTLE_RAD) break;
    // One axis at a time — a combined press holds both keys, and the
    // server's quatFromEuler(yaw, pitch, 0) then rotates about BOTH local
    // axes at once (total rate √2× the single-axis rate), so the
    // proportional duration would overshoot. Single-key presses keep the
    // proven single-axis dynamics: a pitch press (local right axis) is a
    // pure elevation change, a yaw press (local up axis) a near-pure
    // heading change. Proportional press: 80 % of the full rotation at the
    // CALIBRATED effective rate (deliberate undershoot — a press can never
    // cross the target), clamped to [80, 450] ms (min press vs key-event
    // latency).
    for (const axis of [
      {
        err: a.yawErr,
        rate: rateYaw,
        key: (e: number) => (e * dSign > 0 ? 'd' : 'a'),
      },
      {
        err: a.pitchErr,
        rate: ratePitch,
        key: (e: number) => (e * rSign > 0 ? 'r' : 'f'),
      },
    ]) {
      if (Math.abs(axis.err) < AIM_SETTLE_RAD) continue;
      if (Date.now() >= aimDeadline) break;
      const ms = Math.min(450, Math.max(80, (Math.abs(axis.err) / axis.rate) * 1000 * 0.8));
      await press([axis.key(axis.err)], ms);
      // Let the server DRAIN the last held control frame before the next
      // press/probe: the server holds a frame until the next input
      // arrives, so a probe right after key-up reads pre-drain state and
      // the loop can exit while the ship is still turning (observed:
      // 7.0° final error from a 2.9° settle).
      await page.waitForTimeout(300);
    }
  }
  // Settle so the server's final tick (20 Hz) lands before the readout.
  await page.waitForTimeout(200);
  a = await aimProbe();
  const finalYawErr = a?.yawErr ?? Number.NaN;
  const finalPitchErr = a?.pitchErr ?? Number.NaN;
  console.log(
    `[TASK-76] aimed at the dome centre: heading error ${(finalYawErr * 57.3).toFixed(1)}°, ` +
      `pitch error ${(finalPitchErr * 57.3).toFixed(1)}°`,
  );
  expect(a, 'aim probe lost the ship before the aim could converge').not.toBeNull();
  expect(
    Math.abs(finalYawErr),
    `aim did not converge: heading error ${(finalYawErr * 57.3).toFixed(1)}° (need < ` +
      `${(AIM_TOLERANCE_RAD * 57.3).toFixed(1)}°) — the band must not be measured with the nose ` +
      `pointing the wrong way`,
  ).toBeLessThan(AIM_TOLERANCE_RAD);
  expect(
    Math.abs(finalPitchErr),
    `aim did not converge: pitch error ${(finalPitchErr * 57.3).toFixed(1)}° (need < ` +
      `${(AIM_TOLERANCE_RAD * 57.3).toFixed(1)}°) — the band must not be measured with the nose ` +
      `pointing the wrong way`,
  ).toBeLessThan(AIM_TOLERANCE_RAD);

  // Aimed: release the hover so the measurement state is the plain
  // (thrustless, no-VTOL) flight the server keeps simulating.
  await page.keyboard.up(' ');

  // --- Pin the measurement spot -----------------------------------------
  // The aim takes a couple of seconds; the VTOL demand (TASK-86: 1.35×g)
  // CLIMBS the ship away from 60 u during the aim, so re-teleport to the
  // SAME spot (orientation is untouched by the teleport —
  // shard.teleportForTesting only sets pos/vel) so the band is measured at
  // exactly 60 u.
  const pin = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { ...auth, 'content-type': 'application/json' },
    data: spot,
  });
  expect(pin.status(), `re-pin teleport: ${await pin.text()}`).toBe(200);
  let pinned = false;
  const pinDeadline = Date.now() + 10_000;
  while (Date.now() < pinDeadline) {
    const v = await state(spot);
    lastRegime = v.regime || lastRegime;
    if (v.near && v.regime === 'atmosphere') {
      pinned = true;
      break;
    }
    await page.waitForTimeout(400);
  }
  expect(pinned, `ship never re-settled at the pin spot (regime: ${lastRegime})`).toBe(true);

  // The CENTRAL top band shows the dome haze color, not the clipped cap
  // (mean > 20 — per the TASK-76.1 escalation, option A: at this seed the
  // spot's haze is ≈ 0.58, so pre-fix the whole band (aimed inside the
  // clipped cap) reads ~11-13 and post-fix the dome haze reads ~66).
  // (The full-width band is logged too: pre-fix a LEVEL aim would average
  // in the visible blue dome ring and stay bright even while the cap is
  // clipped — which is why the aim pitches at the dome centre and the
  // assertion targets the central strip.)
  const top = await canvasRegionStats(page, TOP_BAND);
  const fullTop = await canvasRegionStats(page, FULL_TOP_BAND);
  const haze = (1 - ALT_OFFSET_U / 1000) * Math.min(1, target.density / 0.1); // shared hazeFactor
  console.log(
    `[TASK-76] off-centre ${usedOffset} u from the pad (${Math.hypot(
      spot.x - anchor.x,
      spot.z - anchor.z,
    ).toFixed(0)} u from the anchor), altitude ${ALT_OFFSET_U} u, ` +
      `haze≈${haze.toFixed(2)}, regime=${lastRegime}: ` +
      `central top band mean=${top.mean.toFixed(1)} bright=${top.bright}, ` +
      `full top band mean=${fullTop.mean.toFixed(1)}`,
  );
  expect(top.mean, 'top band must show the haze color, not the clipped cap').toBeGreaterThan(20);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-76-1.png'),
  });
  assertClean();
  await context.close();
});
