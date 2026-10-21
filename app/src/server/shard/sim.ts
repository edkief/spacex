/**
 * The 20 Hz sim loop — TASK-13 keystone.
 *
 * Architecture (per the spec):
 *
 *   ┌─────────┐    ┌────────────┐    ┌────────────────┐    ┌───────────────┐
 *   │ now()   │ ─▶ │ accumulator│ ─▶ │ one or more 1/20 s │ ─▶ │ onTick callback│
 *   │ wallclk │    │ += elapsed │    │ steps (max 5)        │    │ integration    │
 *   └─────────┘    └────────────┘    └────────────────┘    └───────────────┘
 *
 * Drift correction uses an `accumulator` instead of a fixed
 * `setInterval`. Pros:
 *
 *   - Skipped ticks (e.g. GC pause on the main loop) get caught up
 *     automatically — the next microtask just integrates more steps.
 *   - We never run *zero* steps (would mean we never integrate, would
 *     mean we drop server frames under load). Counter-arg: under
 *     pathological main-loop stalls we hit the **max 5 ticks per
 *     catch-up burst** ceiling so the loop can't spiral into an
 *     unbounded number of steps (the "spiral-of-death" pattern).
 *   - The scheduler is `setTimeout(0)` chained on completion: this
 *     yields the loop to the event loop so handlers (e.g. WS
 *     `message`) get a fair share of CPU.
 *
 * Tick cadence:
 *
 *   - **20 Hz** (every 1/20 s = 50 ms). The integration step is
 *     `dt = TICK_S = 0.05`.
 *   - Every 2nd tick (10 Hz) the loop fires the snapshot observer,
 *     which the shard uses to broadcast `entity_update` to all
 *     connections.
 *   - The `inputsApplied` / `staleInputs` counters expose how many
 *     `PlayerInput` frames the tick consumed for diagnostics.
 *
 * Drift tests (TASK-13 acceptance):
 *
 *   - **Accumulator math (no drift over 1000 ticks).** A simulated
 *     wall clock of exactly `1000 × TICK_S` produces exactly 1000
 *     ticks, no more, no fewer.
 *   - **Latest-input-wins.** Two `enqueueInput` calls back-to-back
 *     before the next tick produce one integration using the LATEST
 *     input only.
 *   - **Stale-seq ignored.** A new input with `seq <= lastSeq` is
 *     dropped without mutating the entity; the next valid input is
 *     integrated normally.
 *   - **Snapshot cadence exactly 10 Hz (fake timers).** With
 *     `nowMs()` driven by `vi.useFakeTimers`, the broadcast fires
 *     at `tick = 2, 4, 6, …` and never at `tick = 1, 3, 5, …`.
 *   - **Benchmark within budget.** P95 < 30 ms at 16 simulated ships
 *     measured over a 60 s virtual run (per AC).
 *
 * @see ./types.ts for the Shard / SimTickStats contracts.
 * @see ./input-queue.ts for the per-connection slot.
 * @see ./entity.ts for the registry mutation APIs.
 * @see ./histogram.ts for the per-tick duration tracker.
 */
import { EventEmitter } from "node:events";

import { integrateShip, type ShipInput, type ShipState } from "@shared/physics/flight.js";
import {
  integrateCharacter,
  wireInputToCharacterInput,
  type CharacterState,
} from "@shared/physics/character.js";
import type { ProtocolEntityState } from "@shared/protocol/index.js";
import { regimeFor, type Regime, type RegimePlanetContext } from "@shared/regime.js";
import { regimePlanetContexts } from "@shared/regime-planets.js";
import { SHIP_CLASSES } from "@shared/ships.js";

import { cleanupExpiredWrecks } from "./combat.js";
import { cleanupExpiredGroundItems } from "./inventory.js";
import { advanceMining, pushMiningUpdate } from "./mining.js";
import { advanceMissiles, energyRegenFor } from "./weapons.js";
import { advanceTargetLocks } from "./targeting.js";
import { advanceAiRespawns } from "./ai-respawn.js";
import { advanceHazards } from "./hazards.js";
import { tickAi } from "./ai.js";
import { drainInput } from "./input-queue.js";
import { TickHistogram } from "./histogram.js";
import { getTickProfiler } from "./phase-profiler.js";
import type {
  Shard,
  ShardSystemContext,
  SimEntity,
  SimTickObserver,
  SimTickStats,
  PlayerInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Server tick rate (Hz). Spec calls for 20 Hz. */
export const SERVER_TICK_HZ = 20;

/** Per-tick duration in seconds (1 / 20 = 0.05). */
export const TICK_S = 1 / SERVER_TICK_HZ;

/** Per-tick duration in milliseconds. */
export const TICK_MS = TICK_S * 1000;

/** Maximum steps per catch-up burst (anti spiral-of-death). */
export const MAX_CATCHUP_STEPS = 5;

/** Tick interval at which `entity_update` is broadcast (every 2nd tick = 10 Hz). */
export const SNAPSHOT_EVERY_N_TICKS = 2;

/** Soft warning threshold for one tick — anything above this is logged. */
export const TICK_WARN_MS = 30;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SimLoopStats {
  readonly tickCount: number;
  readonly running: boolean;
  readonly histogram: ReturnType<TickHistogram["snapshot"]>;
  /** Total entities the sim is currently integrating. */
  readonly entityCount: number;
  /** Total active connections (regardless of state). */
  readonly connectionCount: number;
  /** Total stale input drops across every connection in this shard. */
  readonly staleDrops: number;
  /**
   * TASK-60: longest run of consecutive `tick()` calls that had to
   * integrate more than one step (a main-loop stall the
   * accumulator had to catch up on). The acceptance criterion is
   * "the catch-up logic must never engage for more than 5
   * consecutive ticks" — this is the number that measures it.
   */
  readonly maxConsecutiveCatchup: number;
  /** Total steps integrated across every `tick()` call. */
  readonly stepsRun: number;
  /** Total `tick()` calls (i.e. scheduler wake-ups, not steps). */
  readonly tickCalls: number;
}

/**
 * Lightweight callbacks the shard supplies. The sim is intentionally
 * narrow — it integrates, builds snapshots, and reports stats. Any
 * side effect (broadcast, persistence) is delegated to the owning
 * shard.
 */
export interface SimLoopHooks {
  /** Build the `EntityState` array for the current tick. */
  buildSnapshot: () => ProtocolEntityState[];
  /** Notify the shard that a snapshot just got broadcast (for timing). */
  onSnapshot?: (tick: number, bytes: number) => void;
  /** Per-tick observer (warn over budget, broadcast timing). */
  onTick?: SimTickObserver;
  /** Clock source (default `Date.now`, override in tests). */
  clock?: () => number;
  /** Logger that swallows debug/warn lines. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "debug" | "error">;
  /**
   * TASK-38: repository handle so the mining state machine can
   * persist inventory + deposit deltas. When omitted (legacy
   * tests that don't exercise mining) the loop falls back to
   * `fallbackRepo` — the test-only in-memory noop shim.
   */
  repo?: import("../db/repo.js").Repository | null;
  /**
   * TEST-ONLY seam: a stand-in for the repository when
   * `repo` is omitted. Defaults to a no-op stub so legacy tests
   * don't crash on the missing field; production wires a real
   * SQLite/Postgres repo via `repo`.
   */
  fallbackRepo?: import("../db/repo.js").Repository | null;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * The 20 Hz simulation loop. One per shard.
 *
 * Ownership model: the `SimLoop` holds the *clock* and a reference to
 * the shard's mutable maps. It does NOT own the maps — the shard
 * owns them. The lifecycle (`start` / `stop`) is owned by the shard;
 * the loop is just the integration workhorse.
 */
export class SimLoop {
  /** Monotonic time at last `tick()` boundary. */
  private lastTickReal: number;
  /** Time (in seconds) accumulated since the last tick. */
  private accumulator = 0;
  /** Number of ticks integrated so far. */
  private tickCount = 0;
  /** Is the loop currently running? */
  private running = false;
  /** Active `setTimeout` handle, if any (used so `stop()` can cancel). */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Histogram of recent tick durations. */
  private readonly histogram = new TickHistogram();
  /** Per-tick stats the loop tracks for the diagnostic snapshot. */
  private inputsAppliedTotal = 0;
  private staleInputsTotal = 0;
  private lastTickEntityCount = 0;
  /**
   * Cumulative `playerId → highest input seq the server has
   * integrated so far` (TASK-14). Routers include this verbatim
   * in the outgoing `entity_update` so the owning client can drain
   * its input queue on reconcile. The map only grows the
   * high-water mark — it never shrinks, so a tick that doesn't
   * process any new inputs still reports the previous value to
   * clients that reconnected mid-stream.
   */
  private lastAppliedSeq: Record<string, number> = {};
  /** TASK-60: catch-up telemetry — consecutive multi-step bursts. */
  private consecutiveCatchup = 0;
  private maxConsecutiveCatchup = 0;
  private stepsRunTotal = 0;
  private tickCallsTotal = 0;

  constructor(
    private readonly shard: Shard,
    private readonly hooks: SimLoopHooks,
  ) {
    // -1 means "uninitialised" — the first `tick()` snapshots the
    // wall clock without integrating, so a tick driven by an external
    // counter always observes exactly TICK_S of elapsed time on the
    // second call. Without this guard, the first call would observe
    // zero elapsed and not step, biasing `tickCount` low by one.
    this.lastTickReal = -1;
  }

  /**
   * TEST-ONLY seam: lazily-set fallback repository. Production
   * threads the real repo through `createShard` so this is never
   * called; the setter exists so legacy unit tests can opt in
   * to mining without rewriting their `createShard` plumbing.
   * Also the field is read in `tick()` as a fallback when
   * `hooks.repo` is omitted (the typical legacy-test case).
   */
  setFallbackRepoForTests(value: import("../db/repo.js").Repository | null): void {
    this.fallbackRepo = value;
  }
  private fallbackRepo: import("../db/repo.js").Repository | null = null;

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickReal = (this.hooks.clock ?? defaultClock)();
    this.accumulator = 0;
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentTick(): number {
    return this.tickCount;
  }

  /** Read-only snapshot of the loop's bookkeeping. */
  stats(): SimLoopStats {
    let staleDrops = 0;
    for (const conn of this.shard.connections.values()) {
      staleDrops += conn.staleDrops;
    }
    return {
      tickCount: this.tickCount,
      running: this.running,
      histogram: this.histogram.snapshot(),
      entityCount: this.lastTickEntityCount,
      connectionCount: this.shard.connections.size,
      staleDrops,
      maxConsecutiveCatchup: this.maxConsecutiveCatchup,
      stepsRun: this.stepsRunTotal,
      tickCalls: this.tickCallsTotal,
    };
  }

  // -------------------------------------------------------------------
  // Per-tick entry point — also exposed so tests can drive it directly
  // with a fake clock and assert cadence / math.
  // -------------------------------------------------------------------

  /**
   * Execute the next logical tick. If `accumulator` is large enough
   * to integrate more than one step (because the main loop stalled),
   * this runs up to `MAX_CATCHUP_STEPS` of them. Excess time stays
   * in `accumulator` for the next call. Returns the number of steps
   * actually run (0..MAX_CATCHUP_STEPS).
   *
   * Public so tests can drive exactly one tick without depending on
   * `setTimeout` timers.
   */
  async tick(): Promise<{ stepsRun: number; didSnapshot: boolean }> {
    const now = (this.hooks.clock ?? defaultClock)();
    if (this.lastTickReal < 0) {
      // First call — prime the clock and don't integrate. The next
      // `tick()` will observe exactly TICK_S of elapsed and step once.
      this.lastTickReal = now;
      return { stepsRun: 0, didSnapshot: false };
    }
    const elapsedSec = Math.max(0, (now - this.lastTickReal) / 1000);
    this.lastTickReal = now;
    this.accumulator += elapsedSec;
    this.tickCallsTotal += 1;

    let stepsRun = 0;
    while (this.accumulator >= TICK_S && stepsRun < MAX_CATCHUP_STEPS) {
      this.accumulator -= TICK_S;
      this.runOneStep();
      stepsRun += 1;
    }

    // TASK-38: advance every active mining row on this tick. The
    // mining state machine is server-timed at 1.5 s per unit; we
    // run it once per tick (20 Hz) so the cadence check is
    // granular enough to catch awards within one frame of the
    // 1.5 s boundary. `advanceMining` is async because it
    // persists inventory + deposit rows; we await it so the
    // snapshot below sees the post-mine shape.
    if (stepsRun > 0) {
      const repo = this.hooks.repo ?? this.fallbackRepo ?? null;
      const mining = (this.shard as Shard & { mining?: Map<string, unknown> }).mining;
      // Fast-path: skip the entire async branch when there are
      // no active mining rows (the dominant case). Legacy tests
      // also benefit — they don't wire a repo and don't expect
      // a Promise to settle.
      if (mining && mining.size > 0) {
        const miningStart = getTickProfiler()?.begin("mining");
        if (!repo) {
          throw new Error("SimLoop: mining is active but no repository is wired");
        }
        const result = await advanceMining(this.shard, repo, {
          nowMs: (this.hooks.clock ?? defaultClock)(),
        });
        // Push mining_update echoes to the owners. We do this here
        // (instead of inside advanceMining) so the WS layer's
        // conn-sender is the only place outbound frames flow.
        for (const id of result.pausedFull) {
          const state = (this.shard as Shard & { mining?: Map<string, unknown> }).mining?.get(
            id,
          ) as
            | { depositId: string; resourceType: string; amount: number; unitsSoFar: number }
            | undefined;
          if (!state) continue;
          pushMiningUpdate(this.shard, id, {
            depositId: state.depositId,
            resourceId: state.resourceType ?? "unknown",
            progressMs: 0,
            unitsSoFar: state.unitsSoFar,
            amount: state.amount ?? 0,
            state: "paused-full",
          });
        }
        for (const d of result.depleted) {
          pushMiningUpdate(this.shard, d.connId, {
            depositId: d.depositId,
            resourceId: "",
            progressMs: 0,
            unitsSoFar: 0,
            amount: 0,
            state: "depleted",
          });
        }
        // Awarded units emit their own `inventory_update` inside
        // `advanceMining`. Per-award `mining_update` echoes are
        // handled there too — see pushMiningUpdate in mining.ts.
        getTickProfiler()?.end("mining", miningStart);
        void result;
      }
    }

    // Catch-up ceiling: drain the excess so we don't carry debt
    // forever. After 5 burst steps we accept a small permanent
    // slowdown rather than letting the loop fall further behind.
    if (this.accumulator >= TICK_S) {
      this.accumulator = 0;
    }

    // TASK-60: catch-up telemetry. `stepsRun > 1` means the main
    // loop stalled long enough for the accumulator to owe us more
    // than one step; the acceptance criterion caps the *run* of
    // such bursts at 5 consecutive scheduler wake-ups.
    this.stepsRunTotal += stepsRun;
    if (stepsRun > 1) {
      this.consecutiveCatchup += 1;
      if (this.consecutiveCatchup > this.maxConsecutiveCatchup) {
        this.maxConsecutiveCatchup = this.consecutiveCatchup;
      }
    } else {
      this.consecutiveCatchup = 0;
    }

    let didSnapshot = false;
    if (stepsRun > 0 && this.tickCount % SNAPSHOT_EVERY_N_TICKS === 0) {
      // TASK-60: snapshot build and broadcast serialize are the two
      // phases that only run on snapshot ticks, so they are timed
      // around the shared serialize below.
      const profiler = getTickProfiler();
      const snapshotStart = profiler?.begin("snapshot");
      const entities = this.hooks.buildSnapshot();
      profiler?.end("snapshot", snapshotStart);
      // TASK-60: ONE `JSON.stringify` per tick. The encoding doubles
      // as the byte estimate (it already was) and is handed to the
      // broadcaster so the WS layer doesn't stringify a second copy
      // of the same payload for 16 connections.
      const broadcastStart = profiler?.begin("broadcast");
      const encoded = this.encodeBroadcast(entities);
      profiler?.end("broadcast", broadcastStart);
      // Pass the per-tick ack map so routers can include it in the
      // outgoing `entity_update` (TASK-14 reconciliation hook).
      this.shard.broadcast(this.tickCount, entities, this.lastAppliedSeq, encoded.json);
      didSnapshot = true;
      this.hooks.onSnapshot?.(this.tickCount, encoded.bytes);
    }

    return { stepsRun, didSnapshot };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * The 1/20 s integration step. Called by `tick()`. Mutates entity
   * state in place — the only place mutation is legal.
   */
  private runOneStep(): void {
    const tickStart = (this.hooks.clock ?? defaultClock)();
    // TASK-60: while the phase profiler is attached, measure the tick
    // on the monotonic high-resolution clock too. `Date.now()` has
    // 1 ms granularity, which is coarser than a healthy 20 Hz tick;
    // the bench needs to see the real distribution, production keeps
    // the coarse (allocation-free) clock.
    const tickStartPerf = getTickProfiler() !== null ? performance.now() : 0;
    this.tickCount += 1;

    const shard = this.shard;
    let inputsApplied = 0;
    const staleInputs = 0;
    // TASK-60: one profiler read per tick; null in production.
    const profiler = getTickProfiler();

    // 1. Drain each connection's input slot and integrate.
    const inputStart = profiler?.begin("input");
    for (const conn of shard.connections.values()) {
      const input = drainInput(conn);
      // Drain can return `null` (no pending input) OR `undefined`
      // (defensive — the slot may not have been initialised).
      // Treat both as "skip this tick".
      if (input === null || input === undefined) continue;
      // Counted separately by the queue; surface to the tick stats.
      inputsApplied += 1;
      if (conn.entityId === null) {
        // Future TASK-15 will mint the entity on first presence
        // broadcast; for now the entity may not exist if the
        // player joined but hasn't yet spawned.
        continue;
      }
      const entity = shard.entities.get(conn.entityId);
      if (entity === undefined) continue;
      // TASK-32: dispatch by entity kind. Player ships go through
      // the flight-model integrator; characters go through the
      // character integrator (TASK-32). AI ships and wrecks stay
      // inert (TASK-46 will wire the AI state machine).
      const integrateStart = profiler?.begin("integrate");
      if (entity.kind === "player") {
        // TASK-23: a destroyed player entity stays in the registry (so
        // reconnect can find the row), but the integration loop refuses
        // to advance it. The double-destroy guard in
        // `@shared/physics/damage` + the wreck spawn in `combat.ts`
        // already published the `destroyed` event; we just stop
        // touching the position / velocity here.
        if (entity.hull > 0) {
          integrateEntity(entity, input, shard.context);
        }
      } else if (entity.kind === "character") {
        // TASK-32: walk/run/jump/terrain. Characters have no hull,
        // so the destroyed-entity guard from ships doesn't apply.
        integrateCharacterEntity(entity, input, shard.context, shard);
      }
      profiler?.end("integrate", integrateStart);
      // AI ships + wrecks are inert on the tick (TASK-46 will plug
      // them in). They're still in the broadcast loop so clients see
      // them on the snapshot.
      // Record the seq the server actually applied so the owning
      // client can drain its input queue on reconcile (TASK-14).
      // `lastSeq` is the conn's authoritative high-water mark — the
      // tick always integrates the *latest* accepted input, so this
      // is the right ack value.
      this.lastAppliedSeq[conn.playerId] = conn.lastSeq;
    }
    profiler?.end("input", inputStart);

    // 2. Tick AI / wreck entities — TASK-46: drive the AI
    //    state machine (PATROL / AGGRO / ENGAGE / DISENGAGE)
    //    through `tickAi`. Wrecks stay inert (broadcast-only).
    const aiStart = profiler?.begin("ai");
    tickAi({
      shard,
      dt: TICK_S,
      nowMs: (this.hooks.clock ?? defaultClock)(),
    });
    profiler?.end("ai", aiStart);

    // 3. Run observer hooks so the shard can log timing or mark
    //    entities dirty for persistence.
    this.lastTickEntityCount = shard.entities.size;

    // 4. Wreck cleanup (TASK-23). Remove entities whose
    //    `wreckExpiresAt` has passed. Cheap O(n) walk — wrecks are
    //    a tiny fraction of the registry at any moment.
    const cleanupStart = profiler?.begin("cleanup");
    cleanupExpiredWrecks(shard, Date.now());
    // 4a. Rogue-AI respawns (TASK-45). Walk the per-shard timer
    //     map and re-mint any entry whose `respawnAtMs` has
    //     elapsed. O(roster_size) per tick; runs at most once per
    //     120 s per rogue so the amortised cost is negligible.
    advanceAiRespawns(shard, { nowMs: Date.now() });
    // 4b. Ground-item cleanup (TASK-34). Remove entities whose
    //     `expiresAtMs` has passed. The `groundItem` kind was
    //     added in TASK-34; despawn happens after GROUND_ITEM_TTL_MS
    //     (300 s).
    cleanupExpiredGroundItems(shard, Date.now());
    profiler?.end("cleanup", cleanupStart);
    // 4c. Missile advancement (TASK-43). Advance every active
    //     missile homing step, despawn on TTL, apply contact +
    //     splash on impact. The homing turn is 1.5 rad/s, the
    //     projectile speed 120 u/s. Uses the same clock the
    //     tick reads so test fixtures can drive homing with a
    //     fake timer.
    const projectileStart = profiler?.begin("projectiles");
    advanceMissiles(shard, this.hooks.clock ? this.hooks.clock() : Date.now());
    profiler?.end("projectiles", projectileStart);
    // 4d. Target-lock auto-release (TASK-44). Releases locks
    //     whose target died, exited the 1500 m auto-release
    //     radius, or whose 30 s ceiling elapsed. Sends the
    //     `target_released` ack to the owning player and refreshes
    //     every live lock's `target_update` frame.
    advanceTargetLocks(shard, this.hooks.clock ? this.hooks.clock() : Date.now());
    // 4e. Energy regen (TASK-43). Each player / AI ship regens
    //     10 / s of weapon energy so a player who runs dry
    //     recovers within 10 s of idle.
    for (const e of shard.entities.values()) {
      if (e.kind !== "player" && e.kind !== "ai") continue;
      if (e.energy === undefined) continue;
      energyRegenFor(e, TICK_S, Date.now());
    }
    // 4f. Hazard tick (TASK-48). Walks every player's hazard
    //     row + every drone entity; applies storm / radzone
    //     damage to the exposure pool, drives drone aggro /
    //     attack, schedules drone respawn timers on death. The
    //     pass runs at 20 Hz so the HUD's radiation meter
    //     smooths between frames.
    const hazardStart = profiler?.begin("hazards");
    advanceHazards(shard, {
      dt: TICK_S,
      nowMs: this.hooks.clock ? this.hooks.clock() : Date.now(),
    });
    profiler?.end("hazards", hazardStart);
    const tickDuration =
      tickStartPerf > 0
        ? performance.now() - tickStartPerf
        : (this.hooks.clock ?? defaultClock)() - tickStart;
    this.histogram.push(tickDuration);

    const stats: SimTickStats = {
      tick: this.tickCount,
      tickDurationMs: tickDuration,
      entityCount: shard.entities.size,
      inputsApplied,
      staleInputs,
    };
    if (tickDuration > TICK_WARN_MS) {
      this.hooks.logger?.warn?.(
        `[drift-sim] tick ${this.tickCount} took ${tickDuration.toFixed(2)} ms (>= ${TICK_WARN_MS} ms budget)`,
      );
    }
    this.hooks.onTick?.(stats);
    shard.onTickObserver?.(stats);
    this.inputsAppliedTotal += inputsApplied;
    this.staleInputsTotal += staleInputs;
  }

  /**
   * setTimeout(0)-based chain. After each integration burst we
   * schedule the next dispatch on the event loop so handlers run.
   */
  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
      this.schedule();
    }, 0);
    this.timer.unref?.();
  }

  /**
   * Serialize the snapshot exactly once per tick (TASK-60). The
   * resulting JSON is both the byte estimate and the payload the
   * broadcaster reuses, so an N-connection shard pays one
   * `JSON.stringify` instead of N + 1.
   */
  private encodeBroadcast(entities: ProtocolEntityState[]): { json: string; bytes: number } {
    const json = JSON.stringify(entities);
    return { json, bytes: Buffer.byteLength(json, "utf8") };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One player integration. Driven by the player's pending input + the
 * shared flight model. Mutates the entity in place; the broadcast
 * loop reads `entity.pos / vel / quat / regime` directly off the
 * same struct.
 *
 * The integrator in `@shared/physics/flight` returns a fresh
 * `ShipState`; we copy the fields back so the entity keeps its
 * identity (the `id` and per-entity metadata).
 *
 * TASK-25: before integration we resolve the ship's regime via
 * `regimeFor`. The resolved regime feeds two outputs:
 *
 *   1. `integrateShip` — the integrator's drag / VTOL / pad branches
 *      depend on the regime. Passing the resolved regime (rather
 *      than `entity.regime` from the previous tick) keeps the
 *      physics aligned with the state machine — e.g. a ship that
 *      just crossed the atmosphere boundary feels drag this tick,
 *      not next tick.
 *   2. `entity.regime` / `entity.originPlanetId` — written back so
 *      the next broadcast includes the updated regime. The two
 *      state machine outputs the sim cares about.
 *
 * The function tracks regime changes via the `onRegimeChange`
 * callback on the shard (no-op by default); production wires it
 * to the debug logger or a future `regime_event` frame.
 */
function integrateEntity(entity: SimEntity, input: PlayerInput, ctx: ShardSystemContext): void {
  const shipClass = SHIP_CLASSES[entity.classId as keyof typeof SHIP_CLASSES];
  if (!shipClass) {
    // Unknown class id — should be impossible because the wire schema
    // rejects values outside `["scout","freighter","interceptor"]`,
    // but guard anyway so a buggy shard doesn't crash the loop.
    return;
  }

  // Map wire axes → shared flight-model axes. The protocol uses
  // `turn / pitch / yaw`; the flight model uses `yaw / pitch / roll`.
  // v1: `turn` is yaw, `roll` is zero, `pitch` is pitch. Future tasks
  // can remap (e.g. expose a roll axis to the wire).
  const flightInput: ShipInput = {
    thrust: clamp01(input.thrust),
    yaw: clampUnit(input.turn),
    pitch: clampUnit(input.pitch),
    roll: clampUnit(input.yaw),
    up: 0,
  };

  // TASK-25: resolve the canonical regime for this tick BEFORE the
  // physics step so the integrator uses the regime the state machine
  // intends. The list of planets comes from the shard context; the
  // position resolver is `@shared/regime-planets` (deterministic
  // from `(seed, starId, orbitIndex)` so client + server agree).
  const planetContexts = resolveRegimePlanetContexts(ctx);
  const prevRegime: Regime = entity.regime;
  const resolved = regimeFor(
    { x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
    planetContexts,
    prevRegime,
    { x: entity.vel.x, y: entity.vel.y, z: entity.vel.z },
  );

  // Detect a regime change for the optional shard-side hook (debug
  // log; future TASK can wire an entity-level event frame).
  if (resolved.regime !== prevRegime) {
    ctx.onRegimeChange?.({
      entityId: entity.id,
      playerId: entity.playerId ?? undefined,
      from: prevRegime,
      to: resolved.regime,
      planetId: resolved.planetId,
    });
  }

  const prevState: ShipState = {
    pos: { ...entity.pos },
    vel: { ...entity.vel },
    quat: { ...entity.quat },
    regime: resolved.regime,
    onPad: entity.onPad ?? undefined,
  };

  // Build the per-entity `PlanetAtmosphere` if the ship is in
  // atmosphere / surface and knows which planet it came from.
  // The 3×3 chunk cache is per-tick per-ship, so we just construct
  // a fresh `heightAt` wrapper here for the integration call.
  const planet = resolvePlanetContext(entity, ctx, resolved.planetId);

  const next = integrateShip(prevState, flightInput, TICK_S, resolved.regime, shipClass, planet);

  entity.pos.x = next.pos.x;
  entity.pos.y = next.pos.y;
  entity.pos.z = next.pos.z;
  entity.vel.x = next.vel.x;
  entity.vel.y = next.vel.y;
  entity.vel.z = next.vel.z;
  entity.quat.x = next.quat.x;
  entity.quat.y = next.quat.y;
  entity.quat.z = next.quat.z;
  entity.quat.w = next.quat.w;
  entity.regime = next.regime;
  entity.onPad = next.onPad ?? null;
  // TASK-25: persist the new origin planet so a subsequent reload
  // rehydrates the entity into the same atmosphere / surface regime
  // it was in when the shard last flushed (TASK-24).
  if (resolved.planetId !== null) {
    entity.originPlanetId = resolved.planetId;
  } else if (resolved.regime === "space") {
    // Pure space — clear the origin planet so a stale id doesn't
    // bias the next descend.
    entity.originPlanetId = null;
  }
}

/**
 * TASK-32: integrate one on-foot character. Mirrors the ship
 * integration path in shape (one function per entity kind, copy
 * fields back onto the entity, manage regime + origin-planet
 * bookkeeping) but uses the character physics module instead of
 * the flight model.
 *
 * The character integrator takes a `heightAt(x, z)` callback
 * rather than a `PlanetAtmosphere`; we resolve that from the
 * shard context the same way `integrateEntity` does. The
 * `onFoot` discriminator (TASK-31) means the character carries no
 * ship class — we don't look up `SHIP_CLASSES` for it.
 *
 * The character's `vel.y` is set by the integrator from gravity
 * + jump impulse; the broadcast loop reads `entity.pos / .vel /
 * .quat` verbatim so the snapshot stays bit-stable across runs.
 */
function integrateCharacterEntity(
  entity: SimEntity,
  input: PlayerInput,
  ctx: ShardSystemContext,
  shard: Shard,
): void {
  // Resolve the planet for the heightAt callback. Characters
  // never exist in pure space (the disembark path requires a
  // docked ship, which requires an atmosphere/surface planet),
  // so `originPlanetId` is always non-null in practice; we
  // guard anyway so a future task that introduces an on-foot
  // player in a vacuum (e.g. a damaged ship interior) doesn't
  // crash the loop.
  const planetId = entity.originPlanetId;
  const heightAt = planetId !== null ? (ctx.heightAtFor(planetId) ?? (() => 0)) : () => 0;
  // The integrator's `heightAt` returns altitude *above the
  // planet's radius*; the entity stores `pos.y` in world coords
  // (above the planet centre), so we pass the radius through
  // and let the integrator do the translation.
  const planetRadius =
    planetId !== null && ctx.planetById(planetId) ? ctx.planetById(planetId)!.radiusKm * 1000 : 0;

  // TASK-48: a "recovering" character (exposure = 0 + the 5 s
  // recover timer is still running) cannot move or interact.
  // We zero the input axes via a local copy so the original
  // input reference isn't mutated (the input queue still drains
  // for seq accounting, but the character stays put on the
  // surface).
  let effectiveInput = input;
  const ownerConn = lookupConnForCharacter(entity, shard);
  if (ownerConn !== null) {
    const state = shard.playerHazards.get(ownerConn);
    if (state && state.recoveringUntilMs > Date.now()) {
      effectiveInput = {
        ...input,
        thrust: 0,
        turn: 0,
        pitch: 0,
        fire: false,
        action: null,
      };
    }
  }

  // Map the wire-shaped ship input to the character input axes.
  // `thrust → moveZ`, `turn → yaw`, `pitch → moveX`,
  // `fire → run`, `action === "jump" → jump`. The mapping is
  // shared with the client prediction layer so server and
  // client agree on every axis.
  const characterInput = wireInputToCharacterInput({
    thrust: effectiveInput.thrust,
    turn: effectiveInput.turn,
    pitch: effectiveInput.pitch,
    fire: effectiveInput.fire,
    action: effectiveInput.action,
  });

  const prevState: CharacterState = {
    pos: { x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
    vel: { x: entity.vel.x, y: entity.vel.y, z: entity.vel.z },
    quat: { x: entity.quat.x, y: entity.quat.y, z: entity.quat.z, w: entity.quat.w },
    onGround: entity.regime === "surface" && Math.abs(entity.vel.y) < 1e-3,
  };

  const next = integrateCharacter(prevState, characterInput, TICK_S, heightAt, {
    planetRadius,
  });

  entity.pos.x = next.pos.x;
  entity.pos.y = next.pos.y;
  entity.pos.z = next.pos.z;
  entity.vel.x = next.vel.x;
  entity.vel.y = next.vel.y;
  entity.vel.z = next.vel.z;
  entity.quat.x = next.quat.x;
  entity.quat.y = next.quat.y;
  entity.quat.z = next.quat.z;
  entity.quat.w = next.quat.w;
  // Characters always live in the surface regime — they can't be
  // in pure space (no atmosphere), and the only on-foot entry
  // point is disembarking from a docked ship which is in the
  // surface regime (TASK-29 + TASK-31). We keep `entity.regime`
  // pinned to `"surface"` for clarity (the wire already tags
  // character entities via `kind === 'character'`, so this is
  // belt-and-braces).
  entity.regime = "surface";
}

/**
 * Build the per-tick `RegimePlanetContext[]` from the shard's
 * `ShardSystemContext`. Cached per tick so the integration loop
 * doesn't rebuild the list once per ship.
 *
 * `systemSeed` and `systemId` flow through from the shard; the
 * deterministic layout means every peer (server, client prediction,
 * debug overlay) reaches the same coordinates from the same input.
 */
function resolveRegimePlanetContexts(ctx: ShardSystemContext): RegimePlanetContext[] {
  // Cache the result on the context so the second ship in the same
  // tick doesn't pay the build cost. Re-derived when the context's
  // `system` reference changes (e.g. after a hot-reload).
  const cached = (
    ctx as ShardSystemContext & { _regimeCache?: { sys: unknown; list: RegimePlanetContext[] } }
  )._regimeCache;
  if (cached && cached.sys === ctx.system) {
    return cached.list;
  }
  const list = regimePlanetContexts({
    seed: ctx.galaxySeed ?? "drift-dev-seed-001",
    starId: ctx.starId,
    planets: ctx.system.planets,
    heightAtFor: (id) => ctx.heightAtFor(id) ?? (() => 0),
    atmosphereHeightFor: ctx.atmosphereHeightFor,
  });
  (
    ctx as ShardSystemContext & { _regimeCache?: { sys: unknown; list: RegimePlanetContext[] } }
  )._regimeCache = {
    sys: ctx.system,
    list,
  };
  return list;
}

/**
 * Build the `PlanetAtmosphere` the integrator needs for an entity.
 * For TASK-13 the heightAt comes straight from the system context —
 * the future streaming-pipeline task (TASK-26) replaces this with a
 * per-ship cached lookup that warms the 3×3 neighborhood.
 *
 * TASK-25: prefer the `resolvedPlanetId` produced by `regimeFor` so
 * the integrator's atmosphere context matches the regime the state
 * machine just chose. Falls back to `entity.originPlanetId` for the
 * `null` case so a ship that just transitioned to `'space'` (and
 * had its `originPlanetId` cleared) still resolves cleanly.
 */
function resolvePlanetContext(
  entity: SimEntity,
  ctx: ShardSystemContext,
  resolvedPlanetId: string | null,
) {
  const planetId = resolvedPlanetId ?? entity.originPlanetId;
  if (planetId === null) return undefined;
  const planet = ctx.planetById(planetId);
  if (!planet) return undefined;
  const heightAt = ctx.heightAtFor(planetId) ?? (() => 0);
  // TASK-29: attach the per-planet pad list so the integrator's
  // pad detection (and VTOL-assist distance check) sees the pads
  // we seeded in `system-data.ts`.
  const pads = ctx.padsForPlanet?.(planetId);
  return {
    id: planet.id,
    radius: planet.radiusKm * 1000,
    atmosphereHeight: planet.hasAtmosphere ? 10_000 : 0,
    atmosphereDensity: planet.hasAtmosphere ? 1 : 0,
    hasAtmosphere: planet.hasAtmosphere,
    heightAt,
    ...(pads !== undefined ? { pads } : {}),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/**
 * TASK-48: find the connection id that owns a character entity.
 * Used by the character-integration pass to gate the input when
 * the player is in the `recovering` state. Cheap — characters
 * are bounded, so the linear scan is fine.
 */
function lookupConnForCharacter(entity: SimEntity, shard: Shard): string | null {
  // Match by entity id (the connection's `entityId` is the
  // character's id when the player is on foot).
  for (const [connId, conn] of shard.connections) {
    if (conn.entityId === entity.id) return connId;
  }
  // Fallback: match by playerId (covers the rare case where
  // `entityId` was rebound mid-tick).
  for (const [connId, conn] of shard.connections) {
    if (conn.playerId === entity.playerId) return connId;
  }
  return null;
}

function defaultClock(): number {
  // Default clock is `Date.now` so the SimLoop agrees with the
  // WS layer (TASK-67 fix). The WS layer's `now` defaults to
  // `Date.now`, so we match here — otherwise the mining cadence
  // compares `performance.now()` against `Date.now()` (millions
  // of ms apart) and never awards units. `performance.now()` is
  // more monotonic but the WS layer would have to be re-wired
  // in lockstep for it to be a win, so we accept Date.now's
  // clock-jump risk in exchange for cross-layer correctness.
  // Tests can still override `hooks.clock` to a fake timer.
  return Date.now();
}

// ---------------------------------------------------------------------------
// Re-exports — keep the public surface in one place for downstream tests.
// ---------------------------------------------------------------------------

export { entityToWire } from "./entity.js";
export { enqueueInput } from "./input-queue.js";
export type { SimTickObserver } from "./types.js";
export { EventEmitter as ShardEventEmitter };
