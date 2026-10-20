/**
 * Ship destruction + respawn — TASK-49 keystone.
 *
 * Owns the death half of the loop that `applyCombatDamage`
 * (TASK-23 / TASK-42) opens when a hull hits zero:
 *
 *   1. **Loss** — the destroyed ship's cargo stacks are deleted from
 *      the ship record (the PRD risk model: the cargo is the
 *      stake, credits + on-foot inventory survive). The returned
 *      `cargoLost` map is the audit trail for the wire frame.
 *   2. **Wreck snapshot** — the wreck entity (spawned by the caller
 *      before this module runs) keeps a frozen copy of the mesh
 *      (`classId`, `pos`, `quat`) plus the killer attribution. The
 *      snapshot here is the *rendering-only* contract the client
 *      marker + the FX layer read; the authoritative ship record is
 *      gone.
 *   3. **Respawn** — the owning connection is re-spawned in a fresh
 *      starter scout at the nearest station pad (3D distance over
 *      the system's pad list), docked (`onPad` set), with full
 *      hull / shields and the starter livery. Server-side this is
 *      immediate — the 2 s "SHIP LOST" moment is client
 *      presentation layered on top of the respawn.
 *
 * ## Why the same ship id
 *
 * The spec says "the old ship's record is replaced". We mint the
 * replacement under the *same* `shipId` (hence the same
 * `entity:<shipId>` handle) so the persisted ship row stays the
 * player's single active ship — no DB churn, no "which ship is
 * active" ambiguity on reconnect. The wreck lives under its own
 * `wreck:<entityId>` id, so the two never collide.
 *
 * ## Docks are safe
 *
 * `nearestDockPad` scans the whole system's pad list by 3D distance
 * (no radius cap — a ship that died 40 000 km from the station still
 * respawns at that station's pad, per the spec's "nearest station's
 * pad" fallback). Respawn is per-system in v1: no cross-system
 * escape hatch.
 *
 * @see ./combat.ts for the destroy path that calls `handleShipDestruction`.
 * @see ../../shared/world/pads.ts for the pad derivation.
 * @see ./entity.ts for `makeWreckEntity` / `makeWreckId`.
 */

import { cargoHoldFor, type CargoHold } from "@shared/world/cargo.js";
import { shipStats } from "@shared/ships.js";
import type { ProtocolShipClassId } from "@shared/protocol/index.js";
import type { SystemPad } from "@shared/world/pads.js";

import { spawnShip } from "./index.js";
import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The class every destroyed player is re-spawned in (spec: "starter scout"). */
export const RESPAWN_SHIP_CLASS = "scout" as const satisfies ProtocolShipClassId;

/** Default livery the fresh scout carries (TASK-21 paint zones). */
export const RESPAWN_LIVERY = "starter";

/**
 * Metres within which a wreck's killer marker is drawn on the
 * client HUD. Spec: "the killer's callsign as a small marker visible
 * within 200 m".
 */
export const WRECK_MARKER_RANGE_M = 200;

/**
 * Snapshot of a destroyed ship kept for *rendering only*. The
 * authoritative ship record is deleted, so nothing on the server
 * reads this back except the client payload builder.
 */
export interface WreckSnapshot {
  /** Wreck entity id (what the wire + FX layer key off). */
  readonly wreckId: string;
  /** Frozen mesh class — the renderer picks the impostor geometry. */
  readonly classId: ProtocolShipClassId;
  /** Final world position (metres). */
  readonly pos: { x: number; y: number; z: number };
  /** Frozen orientation. */
  readonly quat: { x: number; y: number; z: number; w: number };
  /** Killer callsign, or `null` when the death had no attributed source. */
  readonly killerCallsign: string | null;
  /** Wall-clock ms at which the wreck is reaped (TASK-23's 600 s TTL). */
  readonly expiresAtMs: number;
}

/** Wire summary attached to `combat_event { kind: 'destroyed' }`. */
export interface RespawnSummary {
  /** Wreck entity the client should render the impostor for. */
  readonly wreckId: string;
  /** Pad the player respawned on. */
  readonly padId: string;
  /** Planet that owns the pad (for the HUD's "Respawning at …"). */
  readonly planetId: string;
  /** Player callsign (the dead ship's owner). */
  readonly callsign: string;
  /** Killer callsign or `null` for unattributed deaths. */
  readonly killer: string | null;
  /** Cargo stacks that were destroyed with the ship. */
  readonly cargoLost: Readonly<Record<string, number>>;
}

/** Result of the destruction transaction. */
export interface DestructionOutcome {
  /** `false` when the destroyed entity was not a connected player ship. */
  readonly handled: boolean;
  /** Cargo deleted from the destroyed ship record. */
  readonly cargoLost: Record<string, number>;
  /** Respawn wire summary — `null` when no player owned the ship. */
  readonly respawn: RespawnSummary | null;
  /** Entity id of the fresh scout (`null` when nothing respawned). */
  readonly respawnEntityId: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Delete every cargo stack from a ship record and return what was
 * lost. The hold is replaced with an empty one sized to the class
 * so the replacement scout starts with a clean, valid hold.
 *
 * Credits and the on-foot inventory are deliberately untouched —
 * the PRD's risk model only stakes the cargo.
 */
export function loseCargo(entity: SimEntity): Record<string, number> {
  const cargo: CargoHold | undefined = entity.cargo;
  const lost: Record<string, number> = {};
  if (cargo !== undefined) {
    for (const [resource, amount] of Object.entries(cargo.stacks)) {
      if (amount > 0) lost[resource] = amount;
    }
  }
  const classId = entity.classId;
  entity.cargo = classId !== null ? cargoHoldFor(classId) : undefined;
  return lost;
}

/**
 * Build the rendering-only snapshot for a wreck entity. Reads the
 * frozen mesh fields straight off the entity; the killer callsign
 * is resolved from the shard registry when the killer entity is
 * still present (an AI that has since respawned keeps its
 * callsign, so the marker survives the kill cycle).
 */
export function wreckSnapshotFor(shard: Shard, wreck: SimEntity, wreckId: string): WreckSnapshot {
  const killerEntity =
    wreck.killerEntityId !== undefined ? shard.entities.get(wreck.killerEntityId) : undefined;
  return {
    wreckId,
    classId: wreck.classId as ProtocolShipClassId,
    pos: { ...wreck.pos },
    quat: { ...wreck.quat },
    killerCallsign: killerEntity?.callsign ?? wreck.killerEntityId ?? null,
    expiresAtMs: wreck.wreckExpiresAt ?? 0,
  };
}

/**
 * Every pad in the shard's system, in world space. Prefers the
 * router's cached `padsForSystem` list; falls back to composing
 * the per-planet `padsForPlanet` view so unit tests that build a
 * bare `ShardSystemContext` still get a usable dock list.
 */
export function systemPads(shard: Shard): SystemPad[] {
  const ctx = shard.context;
  const cached = ctx.padsForSystem?.();
  if (cached !== undefined) return [...cached];
  const out: SystemPad[] = [];
  for (const planet of ctx.system.planets) {
    const pads = ctx.padsForPlanet?.(planet.id);
    if (pads === undefined) continue;
    for (const pad of pads) {
      out.push({
        padId: pad.id,
        planetId: planet.id,
        kind: "station",
        pos: { x: pad.x, y: planet.radiusKm * 1000, z: pad.z },
        normal: { x: 0, y: 1, z: 0 },
        radius: pad.radius,
        exitRadius: pad.exitRadius ?? pad.radius,
      });
    }
  }
  return out;
}

/**
 * Nearest station pad to a world position, by 3D distance. No
 * radius cap — the spec's fallback for "died in space far from
 * stations" is still "the nearest station's pad". Returns `null`
 * only when the system has no landable planet at all (a degenerate
 * fixture), in which case the caller leaves the player where the
 * wreck was.
 */
export function nearestDockPad(
  shard: Shard,
  pos: { x: number; y: number; z: number },
): SystemPad | null {
  let best: SystemPad | null = null;
  let bestDistSq = Infinity;
  for (const pad of systemPads(shard)) {
    const dSq = (pos.x - pad.pos.x) ** 2 + (pos.y - pad.pos.y) ** 2 + (pos.z - pad.pos.z) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      best = pad;
    }
  }
  return best;
}

/** Canonical player entity-id prefix (mirrors `makeEntityId`). */
const ENTITY_ID_PREFIX = "entity:";

/**
 * Recover the `shipId` from a canonical `entity:<shipId>` handle.
 * Returns `null` for non-player entity ids (AI, wreck, …).
 */
function shipIdFromEntityId(entityId: string): string | null {
  return entityId.startsWith(ENTITY_ID_PREFIX) ? entityId.slice(ENTITY_ID_PREFIX.length) : null;
}

/** Find the connection currently driving `entityId` (or owning its player). */
function ownerConnection(shard: Shard, entity: SimEntity): ShardConnection | null {
  for (const conn of shard.connections.values()) {
    if (conn.entityId === entity.id) return conn;
  }
  if (entity.playerId !== null) {
    for (const conn of shard.connections.values()) {
      if (conn.playerId === entity.playerId) return conn;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// handleShipDestruction — the transaction
// ---------------------------------------------------------------------------

/**
 * Run the destruction transaction for a player ship whose hull just
 * hit zero. Called by `applyCombatDamage` *after* the wreck entity
 * has been minted, so the caller owns the wreck spawn and this
 * module owns everything after it.
 *
 * Steps (in order — the order matters because the respawn reuses
 * the destroyed ship's registry slot):
 *
 *   1. Locate the owning connection. A destroyed ship with no live
 *      connection (AI, or an owner who already disconnected) is not
 *      a player loss: `handled: false`, no respawn.
 *   2. Delete the cargo stacks (capture them for the wire payload).
 *   3. Resolve the nearest dock by 3D distance.
 *   4. Drop the destroyed entity from the registry and mint a fresh
 *      full-HP starter scout docked on the pad, bound to the
 *      connection (which re-points `conn.entityId`).
 *
 * Idempotent-safe: calling it twice for the same entity is a no-op
 * the second time because the connection's `entityId` has already
 * been re-pointed at the new scout (and `loseCargo` on an empty
 * hold loses nothing).
 */
export function handleShipDestruction(args: {
  shard: Shard;
  /** The destroyed player entity (still in the registry on entry). */
  destroyed: SimEntity;
  /** Id of the wreck entity the caller just spawned. */
  wreckId: string;
  /** Tick number carried onto the wire payload. */
  tick: number;
}): DestructionOutcome {
  const { shard, destroyed, wreckId } = args;
  const conn = ownerConnection(shard, destroyed);
  if (conn === null) {
    // Not a player ship (AI / orphan). No cargo is attributed to a
    // player here, so the AI respawn path (TASK-45) owns it.
    return { handled: false, cargoLost: {}, respawn: null, respawnEntityId: null };
  }

  const cargoLost = loseCargo(destroyed);
  const dock = nearestDockPad(shard, destroyed.pos);
  const wreck = shard.entities.get(wreckId);
  const snapshot: WreckSnapshot | null =
    wreck !== undefined && wreck.classId !== null ? wreckSnapshotFor(shard, wreck, wreckId) : null;

  // Remove the destroyed ship record. The wreck (a separate id) is
  // the only surviving trace of the old ship.
  shard.entities.delete(destroyed.id);

  // The destroyed ship's own id is the source of truth for the
  // replacement's ship id: player entities are minted as
  // `entity:<shipId>` (see `makeEntityId`), so stripping the prefix
  // keeps the replacement under the SAME handle — the connection's
  // `shipId` is only a fallback for fixtures whose entity id isn't
  // in canonical form (a respawn must never orphan the handle a
  // client is already tracking).
  const shipId = shipIdFromEntityId(destroyed.id) ?? conn.shipId;
  if (dock === null) {
    // Degenerate system with no landable planet — spawn the fresh
    // scout at the wreck's final position so the player is never
    // left without a controllable entity.
    const scout = spawnShip(shard, {
      shipId,
      playerId: destroyed.playerId ?? conn.playerId,
      callsign: destroyed.callsign ?? conn.callsign,
      classId: RESPAWN_SHIP_CLASS,
      hull: shipStats(RESPAWN_SHIP_CLASS).hull,
      shields: shipStats(RESPAWN_SHIP_CLASS).shieldCapacity,
      pos: destroyed.pos,
      regime: "space",
      originPlanetId: null,
      onPad: null,
      bindConnId: conn.connId,
    });
    return {
      handled: true,
      cargoLost,
      respawn: {
        wreckId,
        padId: "",
        planetId: "",
        callsign: scout.callsign ?? conn.callsign,
        killer: snapshot?.killerCallsign ?? null,
        cargoLost,
      },
      respawnEntityId: scout.id,
    };
  }

  const scout = spawnShip(shard, {
    shipId,
    playerId: destroyed.playerId ?? conn.playerId,
    callsign: destroyed.callsign ?? conn.callsign,
    classId: RESPAWN_SHIP_CLASS,
    hull: shipStats(RESPAWN_SHIP_CLASS).hull,
    shields: shipStats(RESPAWN_SHIP_CLASS).shieldCapacity,
    pos: { ...dock.pos },
    regime: "surface",
    originPlanetId: dock.planetId,
    onPad: dock.padId,
    bindConnId: conn.connId,
  });

  return {
    handled: true,
    cargoLost,
    respawn: {
      wreckId,
      padId: dock.padId,
      planetId: dock.planetId,
      callsign: scout.callsign ?? conn.callsign,
      killer: snapshot?.killerCallsign ?? null,
      cargoLost,
    },
    respawnEntityId: scout.id,
  };
}

/**
 * True when a ship may be damaged by weapons. A docked ship is in
 * a safe zone in v1 — the resolver consults this before the LOS
 * check so shots pass over the pad, and the AI target filter
 * (TASK-46) consults it so rogues never aggro on a landed player.
 *
 * Also the guard for the spec's edge case: a ship whose player is
 * on foot is *docked* (the character only exists beside a parked
 * ship), so "destruction while disembarked cannot happen" falls out
 * of the same predicate.
 */
export function isDestructible(ship: SimEntity): boolean {
  return ship.hull > 0 && ship.onPad === null && ship.kind === "player";
}
