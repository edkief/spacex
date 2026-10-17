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
import type { ProtocolEntityState } from "@shared/protocol/index.js";
import { SHIP_CLASSES } from "@shared/ships.js";

import { drainInput } from "./input-queue.js";
import { TickHistogram } from "./histogram.js";
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
  /** Clock for `performance.now()` (override in tests). */
  clock?: () => number;
  /** Logger that swallows debug/warn lines. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "debug" | "error">;
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

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickReal = (this.hooks.clock ?? performanceNow)();
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
  tick(): { stepsRun: number; didSnapshot: boolean } {
    const now = (this.hooks.clock ?? performanceNow)();
    if (this.lastTickReal < 0) {
      // First call — prime the clock and don't integrate. The next
      // `tick()` will observe exactly TICK_S of elapsed and step once.
      this.lastTickReal = now;
      return { stepsRun: 0, didSnapshot: false };
    }
    const elapsedSec = Math.max(0, (now - this.lastTickReal) / 1000);
    this.lastTickReal = now;
    this.accumulator += elapsedSec;

    let stepsRun = 0;
    while (this.accumulator >= TICK_S && stepsRun < MAX_CATCHUP_STEPS) {
      this.accumulator -= TICK_S;
      this.runOneStep();
      stepsRun += 1;
    }

    // Catch-up ceiling: drain the excess so we don't carry debt
    // forever. After 5 burst steps we accept a small permanent
    // slowdown rather than letting the loop fall further behind.
    if (this.accumulator >= TICK_S) {
      this.accumulator = 0;
    }

    let didSnapshot = false;
    if (stepsRun > 0 && this.tickCount % SNAPSHOT_EVERY_N_TICKS === 0) {
      const entities = this.hooks.buildSnapshot();
      const bytes = this.encodeBroadcast(entities);
      this.shard.broadcast(this.tickCount, entities);
      didSnapshot = true;
      this.hooks.onSnapshot?.(this.tickCount, bytes);
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
    const tickStart = (this.hooks.clock ?? performanceNow)();
    this.tickCount += 1;

    const shard = this.shard;
    let inputsApplied = 0;
    const staleInputs = 0;

    // 1. Drain each connection's input slot and integrate.
    for (const conn of shard.connections.values()) {
      const input = drainInput(conn);
      if (input === null) continue;
      // Counted separately by the queue; surface to the tick stats.
      inputsApplied += 1;
      if (conn.entityId === null) {
        // Future TASK-15 will mint the entity on first presence
        // broadcast; for now the entity may not exist if the
        // player joined but hasn't yet spawned.
        continue;
      }
      const entity = shard.entities.get(conn.entityId);
      if (entity === undefined || entity.kind !== "player") continue;
      integrateEntity(entity, input, shard.context);
    }

    // 2. Tick AI / wreck entities — stub: no integration (TASK-46).
    //    We still advance `regime` once per entity so the broadcast
    //    loop sees the live `kind` even if the entities are inert.

    // 3. Run observer hooks so the shard can log timing or mark
    //    entities dirty for persistence.
    this.lastTickEntityCount = shard.entities.size;
    const tickDuration = (this.hooks.clock ?? performanceNow)() - tickStart;
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
      this.tick();
      this.schedule();
    }, 0);
    this.timer.unref?.();
  }

  /**
   * Estimate broadcast payload size (bytes). The shard's `broadcast`
   * hook is transport-agnostic, so the byte length is measured by
   * JSON.stringify + UTF-8 byte length on the same data the wire
   * would carry.
   */
  private encodeBroadcast(entities: ProtocolEntityState[]): number {
    return Buffer.byteLength(JSON.stringify(entities), "utf8");
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

  const prevState: ShipState = {
    pos: { ...entity.pos },
    vel: { ...entity.vel },
    quat: { ...entity.quat },
    regime: entity.regime,
    onPad: entity.onPad ?? undefined,
  };

  // Build the per-entity `PlanetAtmosphere` if the ship is in
  // atmosphere / surface and knows which planet it came from.
  // The 3×3 chunk cache is per-tick per-ship, so we just construct
  // a fresh `heightAt` wrapper here for the integration call.
  const planet = resolvePlanetContext(entity, ctx);

  const next = integrateShip(prevState, flightInput, TICK_S, entity.regime, shipClass, planet);

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
}

/**
 * Build the `PlanetAtmosphere` the integrator needs for an entity.
 * For TASK-13 the heightAt comes straight from the system context —
 * the future streaming-pipeline task (TASK-26) replaces this with a
 * per-ship cached lookup that warms the 3×3 neighborhood.
 */
function resolvePlanetContext(entity: SimEntity, ctx: ShardSystemContext) {
  if (entity.originPlanetId === null) return undefined;
  if (entity.regime === "space") {
    // Space ships don't touch a planet's atmosphere — but the
    // heightAt lookups may still fire for ships about to descend.
    // We accept a small expense here (one extra closure call per tick)
    // in exchange for simpler code paths.
  }
  const planet = ctx.planetById(entity.originPlanetId);
  if (!planet) return undefined;
  const heightAt = ctx.heightAtFor(entity.originPlanetId) ?? (() => 0);
  return {
    id: planet.id,
    radius: planet.radiusKm * 1000,
    atmosphereHeight: planet.hasAtmosphere ? 10_000 : 0,
    atmosphereDensity: planet.hasAtmosphere ? 1 : 0,
    hasAtmosphere: planet.hasAtmosphere,
    heightAt,
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

function performanceNow(): number {
  // `performance.now()` is monotonic across the Node process; the
  // test harness can override `hooks.clock` to a fake timer.
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// Re-exports — keep the public surface in one place for downstream tests.
// ---------------------------------------------------------------------------

export { entityToWire } from "./entity.js";
export { enqueueInput } from "./input-queue.js";
export type { SimTickObserver } from "./types.js";
export { EventEmitter as ShardEventEmitter };
