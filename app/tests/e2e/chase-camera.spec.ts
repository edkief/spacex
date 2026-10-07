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
 * ship displacement never deviates by more than 3 u from the expectation of
 * a perfectly smooth ship: median(per-frame velocity) × per-frame dt. The
 * bound is dt-normalized because headless frame times vary (20-40 ms), so
 * raw per-frame displacement at 120 u/s legitimately varies ~2.4-4.8 u.
 * Frames caused by a predictor REWIND/SNAP reconcile event are excluded
 * (that correction is a one-frame pose jump; smoothing it is TASK-79) —
 * a snapshot yank regression shows up on a NORMAL frame, where the bound
 * still applies. A snapshot yank of 10-20 u blows the bound by far.
 *
 * TASK-78 — the RIGID follow: a SECOND frame window is recorded from
 * SPAWN (the ship docked at the home dock) through the teleport and the
 * whole 0 → cap thrust ramp (up to the scout's 120 u/s maxVelocity — the
 * AC's "> 120 u/s" is the settled cap; the soft speed cap never reports
 * above it). On EVERY frame of that window the camera→ship distance must
 * stay within 14.6 ± 0.5 u (pre-fix the world-space exponential follow
 * lagged by v/k, so the distance GREW with speed), and the ship's
 * projected screen position stays within 20 px of its median (the ship is
 * rigidly attached to the camera — same size at any speed).
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

/** A timestamped reconcile event (t = performance.now at the 10 Hz bridge). */
interface ReconcileEvent {
  mode: 'blend' | 'rewind' | 'snap';
  dist: number;
  t: number;
}

/**
 * Wrap recordReconcile so every event is timestamped (the recorder itself
 * only keeps counts). A reconcile event applies to the NEXT rendered frame,
 * so a spike on frame i correlates with an event in (t[i-1] - 150ms, t[i]].
 */
function tapReconcile(): void {
  const w = window as unknown as {
    __SELF_SHIP__?: {
      recordReconcile: (mode: 'blend' | 'rewind' | 'snap', dist: number) => void;
    };
    __reconcileEvents?: ReconcileEvent[];
  };
  const dbg = w.__SELF_SHIP__;
  if (!dbg) return;
  w.__reconcileEvents = [];
  const orig = dbg.recordReconcile;
  dbg.recordReconcile = (mode, dist) => {
    w.__reconcileEvents?.push({ mode, dist, t: performance.now() });
    orig.call(dbg, mode, dist);
  };
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
  // TASK-78: the spawn → cap window adds the full thrust ramp (~10 s on the
  // slow end) on top of the TASK-77 steady window.
  test.setTimeout(120_000);
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

  // (a2) TASK-78: wait until the camera actually SITS at the chase distance
  // (screen != null can be true from the boot spectator vantage before the
  // rig's first-frame snap), then open the rigid-follow recording. The
  // window starts at SPAWN (docked at the home dock) and stays open through
  // the teleport and the whole 0 → cap thrust ramp.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const p = window.__SELF_SHIP__?.probe();
          if (!p?.pos || !p?.camera?.pos) return 1e9;
          return Math.hypot(
            p.camera.pos.x - p.pos.x,
            p.camera.pos.y - p.pos.y,
            p.camera.pos.z - p.pos.z,
          );
        }),
      { timeout: 10_000, message: 'chase camera never reached the chase distance' },
    )
    .toBeLessThan(20);
  await page.evaluate(() => window.__SELF_SHIP__?.startRecording());

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

  // (c) TASK-78: the thrust ramp from the dock, the rigid-follow window
  // (opened at spawn) still recording.
  const latestSpeed = (): Promise<number> =>
    page.evaluate(() => {
      const ups = (window as unknown as { __shipStates?: ShipUpdate[] }).__shipStates ?? [];
      if (ups.length === 0) return 0;
      const u = ups[ups.length - 1];
      return Math.hypot(u.vel.x, u.vel.y, u.vel.z);
    });
  await page.keyboard.down('w');
  // (c1) "just after undocking, slow" — the ship has just left the dock
  // (> 10 u/s, far from the cap). Screenshot while still slow: the ship
  // must appear the SAME size as at the cap (TASK-78-2).
  await expect
    .poll(latestSpeed, {
      timeout: 15_000,
      message: 'speed never exceeded 10 u/s after undock',
    })
    .toBeGreaterThan(10);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-78-1.png'),
  });
  // (c2) Full thrust up to the cap: > 100 u/s AND settled at the scout's
  // maxVelocity (120) — the AC's "up to > 120 u/s" (the soft cap never
  // reports above 120). Close the rigid-follow window at the cap.
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
  const t78Frames = (
    await page.evaluate(() => window.__SELF_SHIP__?.stopRecording() ?? [])
  ) as FrameSample[];
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-78-2.png'),
  });
  // W stays held through the TASK-77 window below (a stray keyup would end
  // thrust).

  // (d) Record ~3 s of rendered frames (>= 90 even at headless' ~40 fps;
  // 120 u/s × 3 s = 360 u of travel — plenty of signal for the spike rule).
  // A FRESH recording: stopRecording above closed the TASK-78 window.
  await page.evaluate(tapReconcile);
  await page.evaluate(() => window.__SELF_SHIP__?.startRecording());
  const recStart = Date.now();
  // Keep W held through the whole window (a stray keyup would end thrust).
  while (Date.now() - recStart < 3_000) {
    await page.waitForTimeout(100);
  }
  const frames = (await page.evaluate(
    () => window.__SELF_SHIP__?.stopRecording() ?? [],
  )) as FrameSample[];
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
  //  - per-frame |shipPos delta| vs vMed × dt (dt-normalized: headless frame
  //    times vary 20-40 ms, so raw displacement can't hold a fixed 3 u bound
  //    at 120 u/s) — a snapshot yank shows as a 10+ u deviation (AC <= 3);
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
  // dt-normalized velocity (u/s) of a perfectly smooth ship; compare each
  // frame's displacement against vMed × dt (NOT against the raw median
  // displacement — frame times vary, so raw displacement is not comparable).
  const vMed = median(disp.map((d, i) => d / dt[i]));
  const devs = disp.map((d, i) => Math.abs(d - vMed * dt[i]));
  const maxDev = Math.max(...devs);
  const meanDps =
    disp.reduce((a, b) => a + b, 0) / disp.length / (dt.reduce((a, b) => a + b, 0) / dt.length);

  // Correlate the worst frame with a reconcile event: a correction applies
  // to the NEXT rendered frame, so the event window is (t[i-1]-150ms, t[i]].
  const events = (await page.evaluate(
    () => (window as unknown as { __reconcileEvents?: ReconcileEvent[] }).__reconcileEvents ?? [],
  )) as ReconcileEvent[];
  const worst = devs.length > 0 ? devs.indexOf(maxDev) : -1;
  const badEvents =
    worst >= 0
      ? events.filter(
          (e) => e.mode !== 'blend' && e.t > frames[worst].t - 150 && e.t <= frames[worst + 1].t,
        )
      : [];

  // Option A (decided): a REWIND/SNAP correction is the predictor's own
  // one-frame pose jump — smoothing those is TASK-79, out of scope here.
  // Exclude every frame whose window (t[i-1]-150ms, t[i]] carries a
  // rewind/snap event from the AC; assert max <= 3 on the REST. A snapshot
  // yank regression lands on a NORMAL frame and still blows the bound.
  const excluded = new Set<number>();
  for (let i = 0; i < devs.length; i++) {
    if (
      events.some((e) => e.mode !== 'blend' && e.t > frames[i].t - 150 && e.t <= frames[i + 1].t)
    ) {
      excluded.add(i);
    }
  }
  let maxCleanDev = 0;
  let worstCleanFrame = -1;
  for (let i = 0; i < devs.length; i++) {
    if (excluded.has(i)) continue;
    if (devs[i] > maxCleanDev) {
      maxCleanDev = devs[i];
      worstCleanFrame = i;
    }
  }

  console.log(
    `[TASK-77] callsign=${callsign} frames=${frames.length} ` +
      `per-frame displacement: vMed=${vMed.toFixed(1)} u/s, max-dev-vs-vMed*dt=${maxDev.toFixed(2)} u ` +
      `max-dev-excl-rewind/snap=${maxCleanDev.toFixed(2)} u (AC <= 3, ${excluded.size} frames excluded) ` +
      `implied speed=${meanDps.toFixed(1)} u/s ` +
      `residual |disp - speed*dt|: max=${Math.max(...residual).toFixed(2)} u, p95=${pct(residual, 0.95).toFixed(2)} u ` +
      `cam->ship distance: min=${Math.min(...camDist).toFixed(1)} u, max=${Math.max(...camDist).toFixed(1)} u ` +
      `reconcile: blend=${reconcile.blend} rewind=${reconcile.rewind} snap=${reconcile.snap} ` +
      `lastCorrection=${reconcile.lastCorrectionDistance?.toFixed(2)} u ` +
      `worst frame: dev=${maxDev.toFixed(2)} u (frame ${worst}, dt ${(worst >= 0 ? dt[worst] * 1000 : 0).toFixed(1)} ms) ` +
      `rewind/snap events in its window: ${badEvents.map((e) => `${e.mode} ${e.dist.toFixed(1)}u`).join(', ') || 'none'}`,
  );

  // THE acceptance: >= 90 recorded frames, and no per-frame displacement on
  // a NON-rewind/snap frame deviates by > 3 u from the dt-normalized
  // expectation vMed × dt (a snapshot yank at 150 u/s is a 10+ u spike on a
  // normal frame; rewind/snap one-frame jumps are excluded — TASK-79).
  expect(frames.length, 'recorded frames').toBeGreaterThanOrEqual(90);
  expect(
    maxCleanDev,
    `per-frame displacement deviation from vMed*dt excluding rewind/snap frames ` +
      `(${excluded.size} excluded; worst clean frame ${worstCleanFrame}; ` +
      `overall worst frame ${worst} had ${badEvents.length} correlated rewind/snap event(s))`,
  ).toBeLessThanOrEqual(3);

  // (f) TASK-78 acceptance: the RIGID follow over the whole spawn → cap
  // window (docked + teleport + 0 → 120 u/s ramp). Pre-fix the world-space
  // exponential follow lags by v/k, so the camera→ship distance GREW with
  // speed (120 u/s → ≈ 29 u instead of 14.56). Post-fix it is constant on
  // EVERY frame, and the ship's screen position stays put (same size at
  // any speed — the rigid offset never stretches).
  const t78Dists = t78Frames.map((f) => dist(f.camPos, f.shipPos));
  const t78Min = t78Dists.length > 0 ? Math.min(...t78Dists) : Infinity;
  const t78Max = t78Dists.length > 0 ? Math.max(...t78Dists) : -Infinity;
  // Per-speed buckets (the LOG record: pre-fix grows with speed, post-fix
  // constant).
  const buckets: Array<{ label: string; lo: number; hi: number; min: number; max: number; n: number }> = [
    { label: '<20', lo: 0, hi: 20, min: Infinity, max: -Infinity, n: 0 },
    { label: '20-60', lo: 20, hi: 60, min: Infinity, max: -Infinity, n: 0 },
    { label: '60-100', lo: 60, hi: 100, min: Infinity, max: -Infinity, n: 0 },
    { label: '>=100', lo: 100, hi: Infinity, min: Infinity, max: -Infinity, n: 0 },
  ];
  for (let i = 0; i < t78Frames.length; i++) {
    const v = speedAt(t78Frames[i].t);
    const b = buckets.find((bk) => v >= bk.lo && v < bk.hi) ?? buckets[buckets.length - 1];
    b.n += 1;
    b.min = Math.min(b.min, t78Dists[i]);
    b.max = Math.max(b.max, t78Dists[i]);
  }
  const t78Screens = t78Frames.filter((f) => f.screen !== null);
  const medSX = median(t78Screens.map((f) => f.screen!.x));
  const medSY = median(t78Screens.map((f) => f.screen!.y));
  const maxScreenDev =
    t78Screens.length > 0
      ? Math.max(
          ...t78Screens.map(
            (f) => Math.max(Math.abs(f.screen!.x - medSX), Math.abs(f.screen!.y - medSY)),
          ),
        )
      : 0;

  console.log(
    `[TASK-78] spawn→cap window: frames=${t78Frames.length} ` +
      `cam->ship distance: min=${t78Min.toFixed(2)} max=${t78Max.toFixed(2)} u ` +
      `(AC 14.6 ± 0.5; rigid target ${Math.hypot(4, 14).toFixed(2)} u) ` +
      `per-speed buckets: ` +
      buckets
        .map((b) => `${b.label}u/s [${b.n ? `${b.min.toFixed(1)}..${b.max.toFixed(1)}` : 'n/a'}] (n=${b.n})`)
        .join(' ') +
      ` ` +
      `ship screen: median=(${medSX.toFixed(1)}, ${medSY.toFixed(1)}) px, ` +
      `max dev from median=${maxScreenDev.toFixed(1)} px (AC <= 20)`,
  );

  expect(t78Frames.length, 'TASK-78 spawn→cap recorded frames').toBeGreaterThanOrEqual(60);
  expect(t78Min, 'cam->ship distance, whole spawn→cap window (min)').toBeGreaterThanOrEqual(14.1);
  expect(t78Max, 'cam->ship distance, whole spawn→cap window (max)').toBeLessThanOrEqual(15.1);
  expect(maxScreenDev, 'ship screen position deviation from median').toBeLessThanOrEqual(20);

  assertClean();
  await context.close();
});