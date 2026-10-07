import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-77 — E2E: the chase camera sees a SMOOTH ship in steady flight.
 *
 * Before the fix the self-ship pose had TWO writers: the 60 fps flight loop
 * (prediction) AND the 10 Hz self entity_update bridge (RAW server snapshot).
 * The snapshot is older than the prediction by network latency + up to one
 * snapshot period — at 150 u/s that is a 10-20 u yank 10×/s: the ship mesh
 * and the rig target jump back toward the camera, then forward again.
 *
 * Measurement (the __SELF_SHIP__ frame recorder, one sample per RENDERED
 * frame): claim → join → teleport the ship into empty space (the home system
 * has rogue AI ships) → hold W until speed > 100 u/s → record ~2 s of frames.
 *
 * Acceptance: over >= 90 recorded frames in steady thrust, the per-frame
 * ship displacement never deviates from the MEDIAN per-frame displacement by
 * more than 3 u (a snapshot yank at 150 u/s shows as a 10+ u spike).
 */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

/** One 10 Hz server entity_update for our ship, stamped when the page saw it. */
interface ShipUpdate {
  pos: Vec3;
  vel: Vec3;
  t: number;
}

/** One rendered frame from the __SELF_SHIP__ recorder. */
interface FrameSample {
  t: number;
  shipPos: Vec3;
  camPos: Vec3;
  screen: { x: number; y: number } | null;
}

interface ReconcileStats {
  blend: number;
  rewind: number;
  snap: number;
  lastCorrectionDistance: number | null;
}

/**
 * Tap the page's WebSocket so every entity_update carrying OUR ship lands in
 * `window.__shipStates` (pos + vel + the local arrival time — the speed
 * series for the displacement-vs-velocity comparison). The client dials
 * through the global constructor (src/client/net/session.ts).
 */
function tapShipState(callsign: string): void {
  const w = window as unknown as { __shipStates?: ShipUpdate[] };
  w.__shipStates = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
      this.addEventListener('message', (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: {
              entities?: Array<{ kind: string; callsign?: string; pos: Vec3; vel?: Vec3 }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e)
            w.__shipStates?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              t: performance.now(),
            });
        } catch {
          // never break the page's networking from a tap
        }
      });
    }
  };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function median(nums: number[]): number {
  const s = [...nums].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(nums: number[], p: number): number {
  const s = [...nums].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

test('chase camera: no per-frame ship displacement spike in steady thrust (TASK-77)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('chase');

  // (a) Claim + a fresh page joined straight into the home system.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;

  const context = await browser.newContext();
  await context.addInitScript(tapShipState, callsign);
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

  // (b) Teleport the ship into empty space (the home system has rogue AI
  // ships) and wait for the rendered ship to arrive.
  const EMPTY = { x: 0, y: 50, z: 3000 };
  const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    data: EMPTY,
  });
  expect(tele.status(), `teleport: ${await tele.text()}`).toBe(200);
  await expect
    .poll(
      () =>
        page.evaluate((p) => {
          const v = window.__SELF_SHIP__?.probe()?.pos ?? null;
          if (!v) return -1;
          return Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z);
        }, EMPTY),
      { timeout: 10_000, message: 'rendered ship never reached the teleport spot' },
    )
    .toBeLessThan(50);

  // (c) HOLD W until the ship is in STEADY thrust: faster than 100 u/s AND
  // settled at the scout's maxVelocity (120) — the median-deviation rule
  // measures steady flight, not the 100→120 acceleration ramp.
  await page.keyboard.down('w');
  const latestSpeed = (): Promise<number> =>
    page.evaluate(() => {
      const ups = (window as unknown as { __shipStates?: ShipUpdate[] }).__shipStates ?? [];
      if (ups.length === 0) return 0;
      const u = ups[ups.length - 1];
      return Math.hypot(u.vel.x, u.vel.y, u.vel.z);
    });
  await expect
    .poll(latestSpeed, {
      timeout: 20_000,
      message: 'speed never exceeded 100 u/s while holding W',
    })
    .toBeGreaterThan(100);
  await expect
    .poll(latestSpeed, {
      timeout: 10_000,
      message: 'speed never settled at the maxVelocity cap while holding W',
    })
    .toBeGreaterThanOrEqual(115);

  // (d) Record ~3 s of rendered frames (>= 90 even at headless' ~40 fps;
  // 120 u/s × 3 s = 360 u of travel — plenty of signal for the spike rule).
  await page.evaluate(() => window.__SELF_SHIP__?.startRecording());
  const recStart = Date.now();
  // Keep W held through the whole window (a stray keyup would end thrust).
  while (Date.now() - recStart < 3_000) {
    await page.waitForTimeout(100);
  }
  const frames = await page.evaluate(
    () => window.__SELF_SHIP__?.stopRecording() ?? [],
  ) as FrameSample[];
  const reconcile = (await page.evaluate(() => window.__SELF_SHIP__?.reconcile)) as ReconcileStats;
  const updates = (await page.evaluate(
    () => (window as unknown as { __shipStates?: ShipUpdate[] }).__shipStates,
  )) as ShipUpdate[];

  // The visual artifact, mid-flight, still holding W.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-77-1.png'),
  });
  await page.keyboard.up('w');

  // (e) Analyse (the step-2 measurement, now asserting):
  //  - per-frame |shipPos delta| vs the MEDIAN per-frame delta — a snapshot
  //    yank shows as a 10+ u deviation (the AC: never more than 3 u);
  //  - per-frame |shipPos delta| minus speed×dt (the residual: ~0 for a
  //    smooth ship; reported, max + p95);
  //  - camera→ship distance min/max (the chase distance stays ~14 u).
  const disp: number[] = [];
  const dt: number[] = [];
  const camDist: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const d = dist(frames[i].shipPos, frames[i - 1].shipPos);
    disp.push(d);
    dt.push((frames[i].t - frames[i - 1].t) / 1000);
  }
  for (const f of frames) camDist.push(dist(f.camPos, f.shipPos));
  const speedAt = (t: number): number => {
    let v = 0;
    for (const u of updates) {
      if (u.t > t) break;
      v = Math.hypot(u.vel.x, u.vel.y, u.vel.z);
    }
    return v;
  };
  const residual = disp.map((d, i) => Math.abs(d - speedAt(frames[i + 1].t) * dt[i]));
  const med = median(disp);
  const maxDev = Math.max(...disp.map((d) => Math.abs(d - med)));
  const meanDps = disp.reduce((a, b) => a + b, 0) / disp.length / (dt.reduce((a, b) => a + b, 0) / dt.length);

  // DIAG (temporary): frame-time stats + the worst displacement outliers
  const dtSorted = [...dt].sort((x, y) => x - y);
  const outlier = disp
    .map((d, i) => ({ d, i, dev: Math.abs(d - med), dt: dt[i] }))
    .sort((a, b) => b.dev - a.dev)
    .slice(0, 5)
    .map((o) => `${o.d.toFixed(2)}u(dev ${o.dev.toFixed(2)}, dt ${(o.dt * 1000).toFixed(1)}ms)`);
  console.log(
    `[TASK-77-DIAG] dt ms: min=${(dtSorted[0] * 1000).toFixed(1)} p50=${(pct(dtSorted, 0.5) * 1000).toFixed(1)} p95=${(pct(dtSorted, 0.95) * 1000).toFixed(1)} max=${(dtSorted[dtSorted.length - 1] * 1000).toFixed(1)} worst=${outlier.join(' | ')}`,
  );
  console.log(
    `[TASK-77] callsign=${callsign} frames=${frames.length} ` +
      `per-frame displacement: median=${med.toFixed(2)} u, max-dev-from-median=${maxDev.toFixed(2)} u (AC <= 3) ` +
      `implied speed=${meanDps.toFixed(1)} u/s ` +
      `residual |disp - speed*dt|: max=${Math.max(...residual).toFixed(2)} u, p95=${pct(residual, 0.95).toFixed(2)} u ` +
      `cam->ship distance: min=${Math.min(...camDist).toFixed(1)} u, max=${Math.max(...camDist).toFixed(1)} u ` +
      `reconcile: blend=${reconcile.blend} rewind=${reconcile.rewind} snap=${reconcile.snap} ` +
      `lastCorrection=${reconcile.lastCorrectionDistance?.toFixed(2)} u`,
  );

  // THE acceptance: >= 90 recorded frames, and no per-frame displacement
  // spike > 3 u from the median (a snapshot yank at 150 u/s is a 10+ u spike).
  expect(frames.length, 'recorded frames').toBeGreaterThanOrEqual(90);
  expect(maxDev, 'per-frame displacement deviation from the median').toBeLessThanOrEqual(3);

  assertClean();
  await context.close();
});
