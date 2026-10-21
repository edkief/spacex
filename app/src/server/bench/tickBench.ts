/**
 * Server tick benchmark — TASK-60 (the server half of the
 * performance contract; TASK-58 is the client half).
 *
 * ## What it measures
 *
 * The **real** `SimLoop` on the **real** worst-case shard (see
 * `./scene.ts`), driven by the **real** wall clock — no fake
 * timers. Over the run it collects:
 *
 *   - the tick histogram (p50 / p95 / max) from the sim's own
 *     `TickHistogram`,
 *   - the **effective tick rate** (integrated steps ÷ wall clock)
 *     and the longest run of consecutive catch-up bursts,
 *   - the **per-phase** cost table (input drain, ship integration,
 *     AI, projectiles, hazards, mining, snapshot build, broadcast
 *     serialize) from the `PhaseProfiler`,
 *   - **heap** samples, with a forced GC before the final sample so
 *     the growth number is live-object growth, not garbage.
 *
 * ## Budgets
 *
 *   p50 < 15 ms · p95 < 30 ms · max < 60 ms · effective rate
 *   >= 15 Hz · max consecutive catch-up <= 5 · heap growth
 *   < 20 MB.
 *
 * @see ./scene.ts for the workload.
 * @see ../shard/phase-profiler.ts for the phase instrument.
 */

import v8 from "node:v8";

import { PhaseProfiler, setTickProfiler } from "../shard/phase-profiler.js";
import { MAX_CATCHUP_STEPS, SERVER_TICK_HZ, TICK_MS } from "../shard/sim.js";
import { handleFire } from "../shard/weapons.js";
import { handleTargetLock, pushPlayerInput } from "../shard/index.js";
import type { PlayerInput } from "../shard/types.js";

import { BENCH_MISSILE_VOLLEY, BENCH_VOLLEY_AT_MS, buildBenchShard } from "./scene.js";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Median tick budget, ms. */
export const TICK_BUDGET_P50_MS = 15;
/** 95th-percentile tick budget, ms. */
export const TICK_BUDGET_P95_MS = 30;
/** Worst-tick budget, ms (a rare GC spike is tolerable). */
export const TICK_BUDGET_MAX_MS = 60;
/** The sim must never run below this effective rate, Hz. */
export const MIN_EFFECTIVE_HZ = 15;
/** Longest tolerated run of consecutive catch-up bursts. */
export const MAX_CATCHUP_RUN = 5;
/** Heap growth ceiling across the run, bytes. */
export const MAX_HEAP_GROWTH_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** One budget line — `ok: false` means the run missed it. */
export interface TickBudget {
  readonly name: string;
  readonly actual: number;
  readonly budget: number;
  readonly ok: boolean;
}

/** The report the CLI prints and the CI test asserts on. */
export interface TickBenchReport {
  readonly label: string;
  /** Wall-clock length of the measured window, ms. */
  readonly durationMs: number;
  /** Integrated steps in the window. */
  readonly ticks: number;
  /** Scheduler wake-ups (`tick()` calls). */
  readonly tickCalls: number;
  /** Median tick, ms. */
  readonly p50Ms: number;
  /** 95th-percentile tick, ms. */
  readonly p95Ms: number;
  /** Worst tick, ms. */
  readonly maxMs: number;
  /** Effective rate = ticks / wall-clock seconds, Hz. */
  readonly effectiveHz: number;
  /** Longest run of consecutive catch-up bursts. */
  readonly maxConsecutiveCatchup: number;
  /** Per-phase cost table, sorted by total cost (hottest first). */
  readonly phases: readonly {
    phase: string;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    totalMs: number;
    calls: number;
  }[];
  /** Heap growth over the run after the final forced GC, bytes. */
  readonly heapGrowthBytes: number;
  /** Live heap after the final GC, bytes. */
  readonly heapUsedBytes: number;
  /** Peak RSS across the run, bytes. */
  readonly peakRssBytes: number;
  /** Live missiles observed at the end of the volley, ms after fire. */
  readonly missileVolleyFired: number;
  /** Every budget line. */
  readonly budgets: readonly TickBudget[];
  /** True when no budget was missed. */
  readonly ok: boolean;
}

/** Options for {@link runTickBench}. */
export interface TickBenchOptions {
  /** Measured window, ms. The CLI uses 120 000; CI uses 10 000. */
  readonly durationMs?: number;
  /** Warmup before the measurement window opens, ms. Default 2 000. */
  readonly warmupMs?: number;
  /** Run label in the report. */
  readonly label?: string;
  /** Force the benchmark's budgets on / off. Default `true`. */
  readonly enforce?: boolean;
  /** Skip the forced GC (some runtimes don't expose it). Default `false`. */
  readonly skipGc?: boolean;
  /**
   * When the missile volley fires, ms into the measured window.
   * Defaults to {@link BENCH_VOLLEY_AT_MS} (30 s); the fast CI run
   * fires it early so the projectile phase is exercised in 10 s.
   */
  readonly volleyAtMs?: number;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Run the worst-case shard for `durationMs` and return the report.
 *
 * The loop is driven by the caller (`runTickBench` awaits
 * `shard.sim.tick()` on a `setTimeout(0)` chain) rather than
 * `sim.start()`, so the driver can script inputs and read the
 * per-call catch-up counters. The accumulator, the step budget and
 * the phases are the production ones — only the scheduler lives
 * here.
 */
export async function runTickBench(options: TickBenchOptions = {}): Promise<TickBenchReport> {
  const durationMs = options.durationMs ?? 10_000;
  const warmupMs = options.warmupMs ?? 2_000;
  const label = options.label ?? "worst-case";
  const volleyAtMs = options.volleyAtMs ?? BENCH_VOLLEY_AT_MS;
  const bench = buildBenchShard();
  const { shard } = bench;

  const profiler = new PhaseProfiler();
  setTickProfiler(profiler);

  const heapBefore = sampleHeap();
  let peakRss = heapBefore.rss;
  let seq = 0;
  let volleyFired = 0;

  // Script the players' inputs. Called once per scheduler wake-up so
  // every connection has a pending frame for the step that follows —
  // exactly the load a 16-client shard carries.
  const scriptInputs = (): void => {
    for (const conn of bench.flying) {
      seq += 1;
      const input: PlayerInput = {
        seq,
        thrust: 0.8,
        turn: 0.35,
        pitch: (seq % 7) / 7 - 0.5,
        yaw: 0,
        fire: true,
        lock: false,
        action: null,
      };
      pushPlayerInput(shard, conn.connId, input);
      const entity = conn.entityId !== null ? shard.entities.get(conn.entityId) : undefined;
      if (entity) entity.energy = 100;
    }
    for (const conn of bench.onFoot) {
      seq += 1;
      pushPlayerInput(shard, conn.connId, {
        seq,
        thrust: 0.6,
        turn: (seq % 5) / 5 - 0.5,
        pitch: 0.4,
        yaw: 0,
        fire: false,
        lock: false,
        action: null,
      });
    }
    // Keep the AI in the fight: the benchmark measures the engaged
    // path, and a destroyed AI would walk the shard out of it.
    for (const id of bench.aiIds) {
      const ai = shard.entities.get(id);
      if (ai) {
        ai.hull = 100;
        ai.energy = 100;
      }
    }
  };

  /** Fire the missile volley once, when the clock reaches the mark. */
  const maybeFireVolley = (elapsedMs: number): void => {
    if (volleyFired > 0 || elapsedMs < volleyAtMs) return;
    let fired = 0;
    // Two rounds of eight: the cap is 16 concurrent missiles and the
    // fixture has 8 missile-capable ships.
    for (let round = 0; round < 2 && fired < BENCH_MISSILE_VOLLEY; round++) {
      for (const conn of bench.flying) {
        if (fired >= BENCH_MISSILE_VOLLEY) break;
        const targetId = bench.aiIds[fired % bench.aiIds.length];
        if (targetId === undefined) break;
        // Missiles need a lock (TASK-44 gate); take one on the
        // target so the volley actually reaches the cap.
        handleTargetLock({ shard, connId: conn.connId, targetId, nowMs: Date.now() });
        const result = handleFire({
          shard,
          connId: conn.connId,
          weapon: "missile",
          targetId,
          nowMs: Date.now(),
        });
        if (result.ok === "accepted") fired += 1;
      }
    }
    volleyFired = fired;
  };

  const startedAt = Date.now();
  let lastSampleAt = startedAt;

  // The measurement window runs on the same `setTimeout(0)`
  // wake-up chain `SimLoop.schedule()` uses; the driver owns it so
  // it can script inputs between steps and sample the heap.
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const warmupEnd = startedAt + warmupMs;
  // Warmup: run the sim, but only open the profiler + histogram
  // window once the caches (regime contexts, flight math, snapshot
  // ring) are hot.
  await new Promise<void>((resolve) => {
    const warm = (): void => {
      if (finished || Date.now() >= warmupEnd) {
        resolve();
        return;
      }
      scriptInputs();
      void shard.sim.tick().then(() => {
        timer = setTimeout(warm, 0);
      });
    };
    warm();
  });

  const measuredStart = Date.now();
  const ticksAtStart = shard.sim.currentTick;
  profiler.reset();
  await new Promise<void>((resolve) => {
    const deadline = measuredStart + durationMs;
    const run = (): void => {
      if (finished || Date.now() >= deadline) {
        resolve();
        return;
      }
      scriptInputs();
      void shard.sim.tick().then(() => {
        const now = Date.now();
        maybeFireVolley(now - startedAt);
        if (now - lastSampleAt > 1_000) {
          lastSampleAt = now;
          peakRss = Math.max(peakRss, sampleHeap().rss);
        }
        timer = setTimeout(run, 0);
      });
    };
    run();
  });
  finished = true;
  if (timer !== null) clearTimeout(timer);
  setTickProfiler(null);

  const measuredMs = Date.now() - measuredStart;
  const ticks = shard.sim.currentTick - ticksAtStart;
  const stats = shard.sim.stats();
  const hist = stats.histogram;
  const effectiveHz = measuredMs > 0 ? (ticks / measuredMs) * 1000 : 0;

  forceGc(options.skipGc === true);
  const heapAfter = sampleHeap();
  peakRss = Math.max(peakRss, heapAfter.rss);

  const phases = [...profiler.report().phases]
    .sort((a, b) => b.totalMs - a.totalMs)
    .map((p) => ({
      phase: p.phase,
      p50Ms: p.p50Ms,
      p95Ms: p.p95Ms,
      maxMs: p.maxMs,
      totalMs: p.totalMs,
      calls: p.calls,
    }));

  const budgets: TickBudget[] = [
    budget("p50 tick", hist.p50, TICK_BUDGET_P50_MS, (a, b) => a < b),
    budget("p95 tick", hist.p95, TICK_BUDGET_P95_MS, (a, b) => a < b),
    budget("max tick", hist.max, TICK_BUDGET_MAX_MS, (a, b) => a < b),
    budget("effective Hz", effectiveHz, MIN_EFFECTIVE_HZ, (a, b) => a >= b),
    budget("consecutive catch-up", stats.maxConsecutiveCatchup, MAX_CATCHUP_RUN, (a, b) => a <= b),
    budget(
      "heap growth MB",
      heapAfter.heapUsed - heapBefore.heapUsed,
      MAX_HEAP_GROWTH_BYTES,
      (a, b) => a < b,
    ),
  ];
  const ok = options.enforce === false ? true : budgets.every((b) => b.ok);

  return {
    label,
    durationMs: measuredMs,
    ticks,
    tickCalls: stats.tickCalls,
    p50Ms: hist.p50,
    p95Ms: hist.p95,
    maxMs: hist.max,
    effectiveHz,
    maxConsecutiveCatchup: stats.maxConsecutiveCatchup,
    phases,
    heapGrowthBytes: heapAfter.heapUsed - heapBefore.heapUsed,
    heapUsedBytes: heapAfter.heapUsed,
    peakRssBytes: peakRss,
    missileVolleyFired: volleyFired,
    budgets,
    ok,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One budget line. */
function budget(
  name: string,
  actual: number,
  limit: number,
  ok: (actual: number, limit: number) => boolean,
): TickBudget {
  return { name, actual, budget: limit, ok: ok(actual, limit) };
}

/** Heap + RSS sample (V8 heap, so the number matches a forced GC). */
function sampleHeap(): { heapUsed: number; rss: number } {
  const heap = v8.getHeapStatistics();
  return { heapUsed: heap.used_heap_size, rss: process.memoryUsage().rss };
}

/**
 * Best-effort forced GC so the heap-growth number is live-object
 * growth rather than uncollected garbage. `global.gc` needs
 * `--expose-gc`; without it the run still reports, just with a
 * conservative (upper-bound) heap number.
 */
function forceGc(skip: boolean): void {
  if (skip) return;
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") return;
  gc();
  gc();
}

/**
 * Budget table for the sim's cadence invariants, exported so the CLI
 * and the CI test agree on what "green" means.
 */
export const TICK_BUDGETS = {
  p50Ms: TICK_BUDGET_P50_MS,
  p95Ms: TICK_BUDGET_P95_MS,
  maxMs: TICK_BUDGET_MAX_MS,
  minEffectiveHz: MIN_EFFECTIVE_HZ,
  maxCatchupRun: MAX_CATCHUP_RUN,
  maxHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
  tickHz: SERVER_TICK_HZ,
  tickMs: TICK_MS,
  catchupSteps: MAX_CATCHUP_STEPS,
} as const;

/** Re-exported so the CLI can report the workload it measured. */
export { BENCH_MISSILE_VOLLEY, BENCH_VOLLEY_AT_MS } from "./scene.js";
export type { BenchShard } from "./scene.js";
