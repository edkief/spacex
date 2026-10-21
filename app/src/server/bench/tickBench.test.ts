/**
 * Server tick benchmark tests — TASK-60.
 *
 * Two layers:
 *
 *   1. **Unit** — the phase profiler's roll-up, the dormant-AI rule,
 *      and the scene's workload contract (16 conns / 10 AI /
 *      20 ground items / 30 deposits / 8 hazard cells). Fast.
 *   2. **CI fast run** — the real worst-case shard for 10 s of wall
 *      clock. The absolute millisecond budgets are a dev-machine
 *      concern (TASK-61 re-runs them on the reference hardware), so
 *      the CI assertion is the machine-independent one the spec
 *      pins: the sim holds its effective rate and never enters a
 *      catch-up spiral. The numbers are still recorded so a
 *      regression shows up as a printed delta.
 */

import { afterEach, describe, expect, it } from "vitest";

import { AI_DORMANT_RANGE_M, AI_DORMANT_TICK_MS, nearestPlayerDistSq } from "../shard/ai.js";
import { PhaseProfiler, setTickProfiler, TICK_PHASES } from "../shard/phase-profiler.js";
import type { SimEntity } from "../shard/types.js";
import {
  BENCH_AI_SHIPS,
  BENCH_DEPOSITS,
  BENCH_GROUND_ITEMS,
  BENCH_HAZARD_CELLS,
  BENCH_PLAYER_CONNS,
  buildBenchShard,
} from "./scene.js";
import { MAX_CATCHUP_RUN, MIN_EFFECTIVE_HZ, runTickBench, TICK_BUDGETS } from "./tickBench.js";

// ---------------------------------------------------------------------------
// Unit — the profiler
// ---------------------------------------------------------------------------

describe("PhaseProfiler", () => {
  afterEach(() => setTickProfiler(null));

  it("reports every phase in canonical order, even the ones that never ran", () => {
    const profiler = new PhaseProfiler();
    expect(profiler.report().phases.map((p) => p.phase)).toEqual([...TICK_PHASES]);
    expect(profiler.report().phases.every((p) => p.calls === 0)).toBe(true);
  });

  it("records one sample per begin/end pair and totals them", () => {
    const profiler = new PhaseProfiler();
    const start = profiler.begin("ai");
    profiler.end("ai", start);
    expect(profiler.report().phases.find((p) => p.phase === "ai")?.calls).toBe(1);
    expect(profiler.report().totalMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores an end() with no begin() (profiler attached mid-phase)", () => {
    const profiler = new PhaseProfiler();
    profiler.end("hazards", undefined);
    expect(profiler.report().phases.find((p) => p.phase === "hazards")?.calls).toBe(0);
  });

  it("ranks the hottest phases, skipping the ones that never ran", () => {
    const profiler = new PhaseProfiler();
    for (let i = 0; i < 3; i++) {
      const start = profiler.begin("snapshot");
      profiler.end("snapshot", start);
    }
    const top = profiler.topPhases(3);
    expect(top[0]?.phase).toBe("snapshot");
    expect(top.every((p) => p.calls > 0)).toBe(true);
  });

  it("reset() clears the window", () => {
    const profiler = new PhaseProfiler();
    profiler.end("input", profiler.begin("input"));
    profiler.reset();
    expect(profiler.report().totalMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit — the dormant-AI rule (TASK-60 tuning pass)
// ---------------------------------------------------------------------------

describe("dormant AI", () => {
  it("measures squared distance from a flat position list", () => {
    const ai = { pos: { x: 10, y: 0, z: 0 } } as unknown as SimEntity;
    expect(nearestPlayerDistSq(ai, [0, 0, 0])).toBeCloseTo(100);
    // Nearest wins: the second player at x=1000 is further than the one at 0.
    expect(nearestPlayerDistSq(ai, [0, 0, 0, 1000, 0, 0])).toBeCloseTo(100);
    expect(nearestPlayerDistSq(ai, [])).toBe(Number.POSITIVE_INFINITY);
  });

  it("runs the full state machine at 20 Hz near a player", async () => {
    const { tickAi } = await import("../shard/ai.js");
    const bench = buildBenchShard();
    // The AI ring sits 620 m from the pad — inside the dormant
    // radius, so every AI keeps its 20 Hz pass.
    const first = bench.shard.entities.get(bench.aiIds[0] ?? "");
    expect(first).toBeDefined();
    const before = first?.pos.x ?? 0;
    tickAi({ shard: bench.shard, dt: 0.05, nowMs: Date.now() });
    tickAi({ shard: bench.shard, dt: 0.05, nowMs: Date.now() + 50 });
    expect(first?.pos.x).not.toBe(before);
  });

  it("drops a far patrol AI to 1 Hz while an engaged one keeps ticking", async () => {
    const { tickAi } = await import("../shard/ai.js");
    const bench = buildBenchShard();
    const id = bench.aiIds[0] ?? "";
    const ai = bench.shard.entities.get(id);
    expect(ai).toBeDefined();
    if (!ai) return;
    // Park the AI far beyond `AI_DORMANT_RANGE_M`.
    ai.pos.x += (AI_DORMANT_RANGE_M + 5_000) * 2;
    const now = 1_000_000;
    const startX = ai.pos.x;
    // First pass establishes the full-tick stamp.
    tickAi({ shard: bench.shard, dt: 0.05, nowMs: now });
    const afterFirst = ai.pos.x;
    // 20 Hz ticks inside the dormant window are skipped...
    for (let i = 1; i <= 10; i++) {
      tickAi({ shard: bench.shard, dt: 0.05, nowMs: now + i * 50 });
    }
    expect(ai.pos.x).toBe(afterFirst);
    // ...and the 1 Hz pass runs the full state machine again.
    tickAi({ shard: bench.shard, dt: 0.05, nowMs: now + AI_DORMANT_TICK_MS });
    expect(ai.pos.x).not.toBe(afterFirst);
    expect(startX).not.toBe(ai.pos.x);
  });
});

// ---------------------------------------------------------------------------
// Unit — the fixture's workload contract
// ---------------------------------------------------------------------------

describe("worst-case shard fixture", () => {
  it("builds the acceptance criteria's workload", () => {
    const bench = buildBenchShard();
    expect(bench.connections).toHaveLength(BENCH_PLAYER_CONNS);
    expect(bench.flying).toHaveLength(8);
    expect(bench.onFoot).toHaveLength(4);
    expect(bench.idle).toHaveLength(4);
    expect(bench.aiIds).toHaveLength(BENCH_AI_SHIPS);
    let groundItems = 0;
    let deposits = 0;
    let characters = 0;
    for (const entity of bench.shard.entities.values()) {
      if (entity.kind === "groundItem") groundItems += 1;
      else if (entity.kind === "deposit") deposits += 1;
      else if (entity.kind === "character") characters += 1;
    }
    expect(groundItems).toBe(BENCH_GROUND_ITEMS);
    expect(deposits).toBe(BENCH_DEPOSITS);
    expect(characters).toBe(4);
    expect(bench.shard.hazardCells.size).toBe(BENCH_HAZARD_CELLS);
    // Two characters are mining, so the mining phase is exercised.
    const mining = (bench.shard as unknown as { mining?: Map<string, unknown> }).mining;
    expect(mining?.size ?? 0).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CI fast run — 10 s of wall clock
// ---------------------------------------------------------------------------

describe("tick budget (CI fast run)", () => {
  it("holds the effective rate and never catches up for 5 consecutive ticks", async () => {
    const report = await runTickBench({
      durationMs: 10_000,
      warmupMs: 1_500,
      volleyAtMs: 3_000,
      label: "ci-fast",
      // The 10 s CI run asserts the cadence invariants only; the
      // millisecond budgets are `npm run bench:tick`'s job.
      enforce: false,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[TASK-60 ci] ticks=${report.ticks} effectiveHz=${report.effectiveHz.toFixed(2)} ` +
        `p50=${report.p50Ms.toFixed(2)}ms p95=${report.p95Ms.toFixed(2)}ms ` +
        `max=${report.maxMs.toFixed(2)}ms catchup=${report.maxConsecutiveCatchup} ` +
        `heapGrowth=${(report.heapGrowthBytes / 1024 / 1024).toFixed(2)}MB`,
    );

    expect(report.ticks).toBeGreaterThan(0);
    // The machine-independent rule: the sim never drops below 15 Hz.
    expect(report.effectiveHz).toBeGreaterThanOrEqual(MIN_EFFECTIVE_HZ);
    // ...and the accumulator's catch-up never runs for more than 5
    // consecutive ticks.
    expect(report.maxConsecutiveCatchup).toBeLessThanOrEqual(MAX_CATCHUP_RUN);
    // The measured phases cover the whole tick, and the three the
    // criteria name are all present in the table.
    const phases = report.phases.map((p) => p.phase);
    for (const phase of ["ai", "projectiles", "snapshot", "broadcast", "mining", "hazards"]) {
      expect(phases).toContain(phase);
    }
    expect(report.phases.every((p) => p.calls > 0)).toBe(true);
    expect(report.missileVolleyFired).toBeGreaterThan(0);
    // Memory: no growth past the leak ceiling across the run.
    expect(report.heapGrowthBytes).toBeLessThan(TICK_BUDGETS.maxHeapGrowthBytes);
  }, 40_000);
});
