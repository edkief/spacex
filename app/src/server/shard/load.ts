/**
 * Shard-spawn hydrate (TASK-24).
 *
 * When the router instantiates a new `Shard` for a system, the sim
 * needs to re-materialise the entities that were alive at the last
 * flush. This module is the matching load-side companion to
 * `./persist.ts`: it reads the durable rows via `repo.listLiveShipsBySystem`,
 * GC's expired wrecks via `repo.deleteExpiredWrecks`, and emits a
 * list of `SimEntitySpec` records the caller can hand to
 * `spawnShip` / `spawnWreck`.
 *
 * The function is deliberately narrow — it does not touch the shard
 * or the entity registry directly. That keeps the load path
 * testable without a live shard fixture and lets the caller sequence
 * "load → spawn → bind connection" however it prefers.
 *
 * Acceptance criteria mapping:
 *
 *   - **Spawn: loads all non-docked ships of the system into sim
 *     entities with their saved state.** The non-docked filter is
 *     `state IN ('flying','onfoot')`; docked ships are skipped here
 *     because the spec says they "load at dock coords" (a forward-
 *     compatible behaviour once TASK-29 lands the landing-pad data;
 *     for now they're filtered out and the boot path will mint a
 *     fresh docked entity on first player connect, since the
 *     position is irrelevant while docked).
 *   - **Destruction persistence: a destroyed ship persists as a
 *     wreck until TTL; after TTL it is gone on next load.** The
 *     `deleteExpiredWrecks` call GC's the expired rows BEFORE the
 *     hydrate so the next load sees a clean registry.
 *   - **Crash test: ship is within 1 u of its last position.**
 *     Position + quat + regime + hull + shields all flow through
 *     `entityToShipPatch` ↔ `shipRowToEntitySpec` so the loaded
 *     entity matches what the live entity looked like at flush time.
 *
 * @see ./persist.ts for the symmetric flush path.
 * @see ./entity.ts for the entity factory.
 * @see ../../shared/galaxy/types.ts for the SystemGen shape.
 */
import type { ProtocolShipClassId } from "@shared/protocol/index.js";
import type { ShipPosition, ShipQuaternion, ShipRegime, ShipRow, ShipState } from "../db/types.js";
import type { Repository } from "../db/repo.js";
import type { SimEntity } from "./types.js";
import type { CargoHold } from "@shared/world/cargo.js";

/**
 * The shape returned by `loadShipsForShard`. Each entry carries
 * enough state to construct a `SimEntity` via `makePlayerEntity` or
 * `makeWreckEntity` without a second DB roundtrip.
 */
export interface SimEntitySpec {
  /** Ship id (matches `ShipRow.id` and `entity:<id>` for entities). */
  readonly shipId: string;
  /** Player owner — `null` for AI/wreck rows (TASK-45 fills AI rows). */
  readonly playerId: string | null;
  /** Callsign — `null` for AI/wreck. */
  readonly callsign: string | null;
  readonly classId: ProtocolShipClassId;
  readonly hull: number;
  readonly shields: number;
  readonly position: ShipPosition;
  readonly velocity: { x: number; y: number; z: number };
  readonly quat: ShipQuaternion;
  readonly regime: ShipRegime;
  readonly originPlanetId: string | null;
  readonly onPad: string | null;
  /** Wall-clock ms epoch when the wreck should GC (TASK-23). */
  readonly wreckExpiresAt: number | null;
  /** `'player' | 'ai' | 'wreck'` — drives the entity factory choice. */
  readonly kind: SimEntity["kind"];
  /** Persisted lifecycle state (forward-compat for TASK-25 regime transitions). */
  readonly state: ShipState;
  /** TASK-39: persistent cargo hold loaded from the ships.cargo JSON column. */
  readonly cargo: CargoHold;
}

/**
 * Load every ship that should hydrate a freshly-spawned shard.
 *
 * Returns an empty array for a system with no players; the caller
 * can skip spawning entirely.
 *
 * Order matches the spec's spawn contract:
 *   1. `deleteExpiredWrecks` — GC rows whose TTL has elapsed.
 *   2. `listLiveShipsBySystem` — read the surviving rows.
 *   3. Map rows → `SimEntitySpec[]` via `shipRowToEntitySpec`.
 *
 * Skips docked ships by default (the spec asks for them to "load at
 * dock coords", which requires TASK-29's landing-pad data). Set
 * `includeDocked` to true to load every row regardless of state;
 * the caller is then responsible for re-placing docked entities.
 */
export async function loadShipsForShard(
  systemId: string,
  repo: Repository,
  options: { nowMs?: number; includeDocked?: boolean } = {},
): Promise<{
  specs: SimEntitySpec[];
  wrecksDeleted: number;
  rowsScanned: number;
}> {
  const nowMs = options.nowMs ?? Date.now();

  // Step 1: GC expired wrecks BEFORE reading so the hydrate step
  // never sees orphan rows.
  const wrecksDeleted = await repo.deleteExpiredWrecks(systemId, nowMs);

  // Step 2: read surviving rows.
  const rows = await repo.listLiveShipsBySystem(systemId, nowMs);
  const includeDocked = options.includeDocked ?? false;
  const specs: SimEntitySpec[] = [];
  for (const row of rows) {
    if (!includeDocked && row.state === "docked") continue;
    specs.push(shipRowToEntitySpec(row));
  }
  return { specs, wrecksDeleted, rowsScanned: rows.length };
}

/**
 * Translate a `ShipRow` into the spawn-ready spec. The mapping is
 * the inverse of `entityToShipPatch` (in `./persist.ts`); both
 * functions live next to each other so a flush ↔ load round-trip is
 * trivial to audit.
 *
 * Pre-TASK-24 rows (no regime/onPad/wreckExpiresAt) flow through
 * cleanly — the repository mapper defaults those fields to identity
 * quat / null / null / null respectively.
 */
export function shipRowToEntitySpec(row: ShipRow): SimEntitySpec {
  const kind: SimEntity["kind"] = row.state === "destroyed" ? "wreck" : "player";
  // The repository never returns rows for AI ships (those are
  // minted by the future TASK-46 state machine). A future migration
  // could persist AI rows too, but the v1 hydrate only deals with
  // player ships + wrecks.
  return {
    shipId: row.id,
    playerId: row.ownerId,
    callsign: null, // populated by the caller (callsign lives in `players`)
    classId: row.classId,
    hull: row.hull,
    shields: row.shields,
    position: row.position,
    velocity: row.velocity,
    quat: row.quat,
    // The mapper already normalised a null regime to `null`; here we
    // coerce it to "space" so the live entity always has a valid
    // string for the integrator. Pre-TASK-24 rows effectively start
    // in space, which is the safest default.
    regime: row.regime ?? "space",
    originPlanetId: null,
    onPad: row.onPad,
    wreckExpiresAt: row.wreckExpiresAt,
    kind,
    state: row.state,
    // TASK-39: persistent cargo hold travels with the ship. Wrecks
    // don't carry cargo by spec — `shipRow.cargo` is still defined
    // (the mapper always normalises it), but we explicitly skip the
    // payload for the wreck path so the broadcast doesn't advertise
    // it.
    cargo: kind === "wreck" ? { stacks: {}, weightUsed: 0, capacity: 0 } : row.cargo,
  };
}

/**
 * Convenience: build a `SimEntity` directly from a `SimEntitySpec`.
 * Centralised so the router + tests share the same construction path.
 *
 * The function is intentionally narrow — it does not call `spawnShip`
 * or `spawnWreck` because those mutate the registry; instead the
 * caller decides which factory to invoke based on `spec.kind`.
 */
export function specToEntityFields(spec: SimEntitySpec): {
  id: string;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number };
  regime: SimEntity["regime"];
  originPlanetId: string | null;
  onPad: string | null;
} {
  return {
    id: entityIdForSpec(spec),
    pos: { x: spec.position.x, y: spec.position.y, z: spec.position.z },
    vel: { ...spec.velocity },
    quat: { x: spec.quat[0], y: spec.quat[1], z: spec.quat[2], w: spec.quat[3] },
    regime: spec.regime,
    originPlanetId: spec.originPlanetId,
    onPad: spec.onPad,
  };
}

/**
 * Translate `shipId` into the canonical entity id the shard uses.
 * Wrecks keep the `wreck:` prefix; player entities get the
 * `entity:` prefix.
 */
export function entityIdForSpec(spec: SimEntitySpec): string {
  if (spec.kind === "wreck") {
    return `wreck:entity:${spec.shipId}`;
  }
  return `entity:${spec.shipId}`;
}
