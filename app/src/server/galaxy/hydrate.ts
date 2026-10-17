/**
 * Entity hydration (TASK-11 + TASK-24).
 *
 * Walks the `SimEntitySpec[]` returned by `loadShipsForShard` and
 * mints one live `SimEntity` per row on the target shard. Centralised
 * so the router's `loadAndRegister` doesn't carry the
 * builder/dispatch logic inline — the result is a `shard` whose
 * `entities` map is fully populated and ready to serve the
 * `enter_system` snapshot.
 *
 * Two flavours of spec:
 *   - **`wreck`** — entities without a connection. We set them
 *     directly via `shard.entities.set(...)` because `spawnWreck`
 *     binds no connection and the broadcast-aware factory adds
 *     nothing here.
 *   - **player / ai** — entities backed by a `ShipRow`. We call
 *     `spawnShip(...)` which is idempotent on entityId (re-running
 *     the hydrate is safe; the existing entity is returned).
 *
 * The callsign lookup runs once up front so each entity mint
 * doesn't issue its own `findPlayerById` roundtrip — bounded to at
 * most `MAX_PLAYERS_PER_SYSTEM = 16` queries, one per unique
 * owner id in the loaded specs.
 *
 * @see ./router.ts for the consumer.
 * @see ../shard/load.ts for the spec shape.
 * @see ../shard/entity.ts for the factories.
 */
import type { Repository } from "../db/repo.js";
import type { Shard } from "../shard/types.js";
import { spawnShip } from "../shard/index.js";
import { type shipRowToEntitySpec, specToEntityFields } from "../shard/load.js";

/** Default TTL applied to rehydrated wrecks without an explicit expiry. */
export const DEFAULT_REHYDRATE_WRECK_TTL_MS = 600_000;

/**
 * Walk the loaded specs and mint one entity per row on `shard`.
 * Idempotent — calling twice with the same specs is safe (the
 * second call returns the existing entities unchanged).
 */
export async function hydrateShardEntities(
  shard: Shard,
  specs: ReturnType<typeof shipRowToEntitySpec>[],
  deps: { repo: Repository },
): Promise<void> {
  // Build an ownerId → callsign lookup once so the entity factory
  // can populate the right callsign without N+1 roundtrips. The
  // callsign is **not** persisted on the ship row (it lives on the
  // player row), so the load path needs the join. The fetch is
  // bounded — the number of owners is at most MAX_PLAYERS_PER_SYSTEM
  // (16), so the loop is small.
  const ownerIds = new Set<string>();
  for (const spec of specs) {
    if (spec.kind !== "wreck" && spec.playerId) {
      ownerIds.add(spec.playerId);
    }
  }
  const callsignsByOwner = new Map<string, string>();
  await Promise.all(
    Array.from(ownerIds).map(async (ownerId) => {
      const player = await deps.repo.findPlayerById(ownerId);
      if (player) callsignsByOwner.set(ownerId, player.callsign);
    }),
  );

  for (const spec of specs) {
    const fields = specToEntityFields(spec);
    if (spec.kind === "wreck") {
      // Wrecks are inert — set the entity directly. The simulator
      // already populates the wreck entity via `makeWreckEntity`;
      // the broadcast-aware factory is unnecessary here because we
      // don't bind a connection.
      shard.entities.set(fields.id, {
        id: fields.id,
        kind: "wreck",
        playerId: null,
        callsign: null,
        classId: spec.classId,
        hull: 0,
        shields: 0,
        targetId: null,
        pos: fields.pos,
        vel: fields.vel,
        quat: fields.quat,
        regime: fields.regime,
        originPlanetId: null,
        onPad: null,
        wreckExpiresAt: spec.wreckExpiresAt ?? Date.now() + DEFAULT_REHYDRATE_WRECK_TTL_MS,
      });
      continue;
    }
    const ownerId = spec.playerId ?? "owner-unknown";
    const callsign = callsignsByOwner.get(ownerId) ?? spec.callsign ?? "UNKNOWN";
    spawnShip(shard, {
      shipId: spec.shipId,
      playerId: ownerId,
      callsign,
      classId: spec.classId,
      hull: spec.hull,
      shields: spec.shields,
      pos: fields.pos,
      vel: fields.vel,
      quat: fields.quat,
      regime: fields.regime,
      originPlanetId: spec.originPlanetId,
      onPad: spec.onPad,
    });
  }
}
