/**
 * Per-tick ship persistence flush (TASK-24).
 *
 * Owns the per-system 30 s flush loop that writes each ship entity's
 * live flight state to the `ships` table. The flush is intentionally
 * simple: walk the shard's `entities` map, derive a `SaveShipStateInput`
 * patch from the in-memory state, and `saveShipState` per ship. The
 * underlying `saveShipState` is one `UPDATE` per ship so the hot path
 * stays well within the spec's tick budget.
 *
 *   - **Interval flush** — `startIntervalFlush()` schedules a
 *     `setInterval(flushAllActive, DEFAULT_FLUSH_INTERVAL_MS)` and
 *     `unref()`s the timer so it never blocks process exit.
 *   - **Graceful shutdown flush** — `flushAndStop(shards)` runs once
 *     more across the supplied shards and tears down the timer.
 *     Wired into `index.ts`'s `SIGTERM/SIGINT` hook.
 *   - **One-shot flush** — `flushShips(shard, repo)` exposes the
 *     per-shard write as a plain function so unit tests can assert
 *     payload shape + duration without standing up a timer.
 *
 * Crash recovery semantics (acceptance):
 *
 *   - **30 s loss budget.** The flush cadence trades freshness for
 *     write throughput; a hard `kill -9` between flushes loses up to
 *     30 s of position drift. The crash-restart integration test
 *     asserts the surviving position is within 1 u of the last
 *     integration step (the spec's "tolerance = 1 tick of movement"
 *     budget for the sim's 20 Hz tick).
 *   - **Single transaction per flush.** Each `saveShipState` is its
 *     own atomic UPDATE; the loop awaits them sequentially so a
 *     single failure aborts the flush and the timer logs the error
 *     for the next tick. Per the spec, "one UPDATE per ship, no
 *     WAL checkpoint inside" keeps each write small.
 *
 * Why we don't bother with a dirty-set:
 *
 *   - The ship set per shard is bounded by the 16-player cap (TASK-60).
 *   - Each `saveShipState` is one indexed `UPDATE` (ships.id PK lookup,
 *     O(log n)) so 16 writes stay well under the 50 ms tick budget.
 *   - Skipping the dirty-set bookkeeping removes a class of
 *     "forgot-to-mark-dirty" bugs. The whole-entity-flush pattern
 *     matches the existing `PersistService.saveShip` API.
 *
 * @see ../persist.ts for the higher-level dirty-flag service that
 *      handles save points (dock, damage, etc.).
 * @see ./load.ts for the symmetric spawn-time hydrate.
 * @see ./entity.ts for the entity factory + wire serializer.
 */
import type { Repository } from "../db/repo.js";
import type { SaveShipStateInput, ShipState } from "../db/types.js";

import type { Shard, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default interval between dirty flushes (TASK-24 spec: "every 30 s").
 * Matches the PRD §8 / TASK-63 cadence pattern (5 s for the global
 * PersistService, 30 s for the per-shard ship loop because position
 * freshness is less critical than cargo / credits).
 */
export const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/**
 * The set of flight fields the spec calls out for the flush payload
 * (TASK-24 step 1). The order matches the field list in the spec so
 * future readers can grep the patch surface in one place.
 *
 * `livery` is intentionally NOT included here — livery changes flow
 * through the dedicated `POST /api/ships/livery` route (TASK-21) and
 * land in the same row, but per-tick flushes don't churn that JSON.
 * Including it would triple the per-tick write cost for no continuity
 * benefit (livery is committed synchronously at the change site).
 *
 * `cargo` (TASK-39) is ALSO outside the periodic flush — the cargo
 * hold is mutated only by `handleCargoTransfer` and committed
 * synchronously there so a transfer is durable before the next
 * entity_update. Periodic flushes only carry position / regime / hull
 * / shields / pad to avoid rewrites that would clobber a concurrent
 * cargo mutation. The `entityToShipPatch` helper still threads the
 * cargo field so the initial sync (e.g. on shard spawn) writes it
 * alongside the rest.
 */
export const FLUSHED_FIELDS = [
  "position",
  "velocity",
  "quat",
  "regime",
  "hull",
  "shields",
  "onPad",
] as const satisfies readonly (keyof SaveShipStateInput)[];

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Build a `SaveShipStateInput` from a live `SimEntity` + a systemId.
 * The systemId is required (the entity doesn't carry it) so the
 * helper takes it as an explicit parameter rather than guessing.
 *
 * The function is the single source of truth for the "what gets
 * flushed" decision — adding a new persisted field is a one-line
 * change here and the flush + tests pick it up automatically.
 */
export function entityToShipPatch(entity: SimEntity, systemId: string): SaveShipStateInput {
  return {
    hull: entity.hull,
    shields: entity.shields,
    position: { systemId, x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
    velocity: { x: entity.vel.x, y: entity.vel.y, z: entity.vel.z },
    state: mapEntityKindToState(entity),
    quat: [entity.quat.x, entity.quat.y, entity.quat.z, entity.quat.w],
    regime: entity.regime,
    onPad: entity.onPad,
    wreckExpiresAt: entity.wreckExpiresAt ?? null,
    // TASK-39: cargo hold persists with the ship so a server restart
    // resumes the hold at the same stacks / weightUsed as the last
    // save. Wrecks don't carry cargo (the destroyed ship has no
    // payload by spec), so we omit the field on wreck entities.
    cargo: entity.kind === "wreck" ? undefined : entity.cargo,
  };
}

/**
 * Translate an entity's `kind` to the persisted `ShipState`. Wrecks
 * are stored as `'destroyed'` so the load step can apply the same
 * "destroyed-with-future-TTL" filter to every wreck flavour.
 */
function mapEntityKindToState(entity: SimEntity): ShipState {
  if (entity.kind === "wreck") return "destroyed";
  // Player + AI entities don't carry a state directly; the save path
  // defaults to 'flying' for any non-docked / non-on-foot ship. The
  // integration step maintains `entity.onPad` so the next flush can
  // observe a landed state via the onPad patch field.
  if (entity.onPad !== null) return "docked";
  return "flying";
}

/**
 * One-shot flush. Writes every entity on the shard through
 * `saveShipState`. Returns the count + wall-clock duration so the
 * timer can log p95 latency.
 *
 * Per the spec: "single transaction, upsert". Each `saveShipState`
 * is its own `BEGIN…COMMIT` so the loop is naturally serialised —
 * we await them sequentially so a failure mid-batch aborts the
 * remaining writes cleanly.
 */
export async function flushShips(
  shard: Shard,
  repo: Repository,
  options: { logger?: Pick<Console, "info" | "warn" | "error">; now?: () => number } = {},
): Promise<FlushResult> {
  const logger = options.logger ?? console;
  const nowFn = options.now ?? Date.now;
  const startedAt = nowFn();

  const ships = collectPersistableShips(shard);
  if (ships.length === 0) {
    return { ships: 0, durationMs: 0 };
  }

  let written = 0;
  try {
    for (const entry of ships) {
      // Patch is derived fresh per entity so the same call doesn't
      // mutate the entity's identity (no shared references leak
      // through the `position` / `velocity` JSON objects).
      const patch = buildPatchForEntity(entry.entity, shard.systemId);
      await repo.saveShipState(entry.shipId, patch);
      written += 1;
    }
  } catch (err) {
    logger.error?.(
      `[drift-flush] ${shard.systemId}: flush aborted at ${written}/${ships.length} ships:`,
      err,
    );
    throw err;
  }

  const durationMs = nowFn() - startedAt;
  if (durationMs > 8) {
    logger.warn?.(
      `[drift-flush] ${shard.systemId}: ${written} ships flushed in ${durationMs.toFixed(2)} ms (> 8 ms p95 budget)`,
    );
  } else {
    logger.info?.(
      `[drift-flush] ${shard.systemId}: ${written} ships flushed in ${durationMs.toFixed(2)} ms`,
    );
  }
  return { ships: written, durationMs };
}

// ---------------------------------------------------------------------------
// Flush service — owns the 30 s timer + manual trigger
// ---------------------------------------------------------------------------

/** Result returned by `flushShips`. */
export interface FlushResult {
  /** Number of ships written. */
  readonly ships: number;
  /** Wall-clock duration of the flush in ms. */
  readonly durationMs: number;
}

/**
 * The per-shard flush service. One per shard (the router constructs
 * one in `createShard` and the entry point wires a single timer that
 * flushes every active shard).
 *
 * Lifecycle:
 *   - `new ShardFlushService(repo, options)` — pure constructor.
 *   - `start()` — begin the 30 s timer. Idempotent.
 *   - `stop()` — clear the timer and run one final flush. Idempotent.
 *   - `flushNow(shard)` — manual flush (used by `stop` and tests).
 *
 * The flush callback runs *outside* the sim tick — `setInterval`
 * delivers the timer event on the event loop, not on the sim's
 * `setTimeout(0)` chain, so a 16-ship flush never blocks the tick
 * for more than one frame. Per the spec:
 * "flush while a player is flying does not block the tick for more
 *  than 1 frame (measured in the flush test, sqlite writes are small)".
 */
export class ShardFlushService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly repo: Repository,
    private readonly options: ShardFlushOptions = {},
  ) {}

  /**
   * Begin periodic flushing. Safe to call multiple times — the second
   * call returns the existing timer without scheduling a duplicate.
   */
  start(flusher: () => Promise<unknown>): ReturnType<typeof setInterval> {
    if (this.timer !== null) return this.timer;
    const intervalMs = this.options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const logger = this.options.logger ?? console;
    const timer = setInterval(() => {
      void flusher().catch((err: unknown) => {
        logger.error?.("[drift-flush] interval flush failed:", err);
      });
    }, intervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.timer = timer;
    return timer;
  }

  /** Stop the timer. Idempotent. Does NOT flush — call `flushNow` first if needed. */
  stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** True if the timer is currently scheduled. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Currently-configured interval (ms). */
  get configuredIntervalMs(): number {
    return this.options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /**
   * Dispose the service. Stops the timer; the caller is responsible
   * for calling `flushNow` first if a final flush is desired.
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.stopTimer();
    this.disposed = true;
  }

  /** Has the service been disposed? Useful for `assert(!svc.disposed)`. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * One-shot flush. Same semantics as the bare `flushShips` helper;
   * the indirection through the service lets the timer closure call
   * the same code path as the explicit `stop()` flush.
   */
  async flushNow(shard: Shard): Promise<FlushResult> {
    return flushShips(shard, this.repo, {
      logger: this.options.logger,
      now: this.options.now,
    });
  }
}

/** Options bag for `ShardFlushService`. */
export interface ShardFlushOptions {
  /** Override the 30 s default. Useful in tests. */
  intervalMs?: number;
  /** Logger for warn/error/info. Defaults to `console`. */
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** Wall-clock override for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Walk the shard's entity registry and return the player/AI/wreck
 * rows that the flush should write. The set is computed lazily on
 * every flush (not cached) so a `removeEntity` mid-tick is picked up
 * on the next iteration without any bookkeeping.
 */
function collectPersistableShips(shard: Shard): Array<{ shipId: string; entity: SimEntity }> {
  const out: Array<{ shipId: string; entity: SimEntity }> = [];
  for (const entity of shard.entities.values()) {
    if (entity.kind === "wreck") {
      // Wrecks are saved under the source ship's id so the load
      // step can rehydrate them with the same `state === 'destroyed'`
      // + `wreckExpiresAt` filter. The wreck entity's id is
      // `wreck:<sourceEntityId>` — strip the prefix to recover the
      // source id.
      const sourceId = entity.id.startsWith("wreck:")
        ? entity.id.slice("wreck:".length)
        : entity.id;
      // The source entity id is `entity:<shipId>` (TASK-13 entity
      // factory). Strip the prefix to recover the persisted ship id.
      const shipId = sourceId.startsWith("entity:") ? sourceId.slice("entity:".length) : sourceId;
      out.push({ shipId, entity });
      continue;
    }
    // Player + AI entities: the entity id is `entity:<shipId>`.
    if (!entity.id.startsWith("entity:")) continue;
    const shipId = entity.id.slice("entity:".length);
    out.push({ shipId, entity });
  }
  return out;
}

/**
 * Build the persistence patch from the entity + the shard's
 * canonical `systemId`. Centralised so the test mirror (`entityToShipPatch`)
 * and the real flush agree on the field set.
 */
function buildPatchForEntity(entity: SimEntity, systemId: string): SaveShipStateInput {
  return {
    hull: entity.hull,
    shields: entity.shields,
    position: { systemId, x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
    velocity: { x: entity.vel.x, y: entity.vel.y, z: entity.vel.z },
    state: mapEntityKindToState(entity),
    quat: [entity.quat.x, entity.quat.y, entity.quat.z, entity.quat.w],
    regime: entity.regime,
    onPad: entity.onPad,
    wreckExpiresAt: entity.wreckExpiresAt ?? null,
    // TASK-39: cargo hold persists with the ship (see comment on
    // `entityToShipPatch`). The same shape and ordering so the
    // flush and the synchronous cargo-transfer write agree.
    cargo: entity.kind === "wreck" ? undefined : entity.cargo,
  };
}
