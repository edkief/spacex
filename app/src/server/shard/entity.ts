/**
 * Entity registry + per-entity helpers — TASK-13.
 *
 * The shard holds a `Map<entityId, SimEntity>`. Mutations happen ONLY
 * inside the sim's `onTick`. Outside the tick (message handlers, future
 * bus subscribers) the only legal operations are:
 *
 *   - `addEntity(...)`    — register a freshly spawned ship
 *   - `removeEntity(...)` — drop a destroyed / undocked entity
 *   - `getEntity(id)`     — read-only access
 *   - `listEntities()`    — snapshot for the broadcast loop
 *
 * Player ships start with `hull` and `shields` pulled from the
 * persisted `ShipRow`. AI ships start at full class-default HP. Wrecks
 * are broadcast-only — they carry the last-known position with hull=0
 * and a dedicated `kind` so the renderer renders the impostor (TASK-49).
 *
 * The module deliberately does NOT import any flight-model state — the
 * `SimEntity` keeps its own `pos / vel / quat` so the shard owns the
 * single source of truth for the snapshot loop.
 *
 * @see ./types.ts for the wire-level entity shape.
 * @see ./sim.ts for the only legal mutator (`onTick`).
 */
import { quatRotateVector, type Vec3 } from "@shared/physics/vec.js";
import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";
import type { ProtocolEntityState, ProtocolShipClassId } from "@shared/protocol/index.js";

import type { SimEntity } from "./types.js";

/**
 * TASK-31: lateral side-offset (in metres) applied to the character
 * spawn position so the player emerges beside the ship's hull, not
 * inside it. 2.5 m keeps the character clear of the 1.5 m half-width
 * scout/freighter impostor plus a small clearance gap, while staying
 * well inside the 20 m pad radius so the character still counts as
 * "on the pad".
 */
export const CHARACTER_SIDE_OFFSET_M = 2.5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stable entity id for a player's ship. Currently the persistent
 * `ShipRow.id`; tracked through reconnect by `loadSystemState`
 * (TASK-17). Uses `entityIdSeed` so two parallel maps (`entities` +
 * `connections.entityId`) cannot diverge.
 */
export function makeEntityId(shipId: string): string {
  return `entity:${shipId}`;
}

/**
 * Mint a `SimEntity` from a persisted `ShipRow`-equivalent. The
 * helper is deliberately narrow so the registry can be exercised
 * from tests without going through the persistence layer.
 *
 * Caller-supplied `id` overrides `makeEntityId(shipId)` so future
 * tasks (TASK-24 / reconnect) can preserve an existing id across
 * regen.
 */
export function makePlayerEntity(args: {
  id: string;
  shipId: string;
  playerId: string;
  callsign: string;
  classId: ProtocolShipClassId;
  hull: number;
  shields: number;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number };
  regime: SimEntity["regime"];
  originPlanetId: string | null;
  onPad: string | null;
}): SimEntity {
  return {
    id: args.id,
    kind: "player",
    playerId: args.playerId,
    callsign: args.callsign,
    classId: args.classId,
    hull: args.hull,
    shields: args.shields,
    targetId: null,
    pos: { ...args.pos },
    vel: { ...args.vel },
    quat: { ...args.quat },
    regime: args.regime,
    originPlanetId: args.originPlanetId,
    onPad: args.onPad,
  };
}

/**
 * Mint an AI entity. TASK-13 advances AI entities as inert (no
 * input, no integration — they just sit there so the snapshot
 * broadcast path is exercised end-to-end). TASK-46 replaces the
 * stub with the AI state machine + integrate ship.
 */
export function makeAiEntity(args: {
  id: string;
  classId: ProtocolShipClassId;
  pos: { x: number; y: number; z: number };
}): SimEntity {
  const cls = SHIP_CLASSES[args.classId as ShipClassId];
  return {
    id: args.id,
    kind: "ai",
    playerId: null,
    callsign: null,
    classId: args.classId,
    hull: cls.hull,
    shields: cls.shieldCapacity,
    targetId: null,
    pos: { ...args.pos },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    onPad: null,
  };
}

/**
 * Mint a wreck entity (TASK-23 / TASK-49). The wreck inherits the
 * destroyed ship's final position and last-known class id so the
 * renderer can pick the right impostor model. Velocity is zeroed
 * (wrecks drift, but the sim doesn't integrate them), shields and
 * hull are 0 (the renderer can show a "dead" wireframe), and the
 * `wreckExpiresAt` field carries the wall-clock ms timestamp at
 * which the sim loop should remove the entry (no persistent wreck
 * registry — see spec technical note).
 *
 * `wreckExpiresAt` is set in ms-from-epoch so the cleanup loop
 * can use a single `Date.now()` comparison rather than tracking
 * ticks.
 */
export function makeWreckEntity(args: {
  id: string;
  classId: ProtocolShipClassId;
  pos: { x: number; y: number; z: number };
  quat?: { x: number; y: number; z: number; w: number };
  wreckExpiresAt: number;
}): SimEntity {
  return {
    id: args.id,
    kind: "wreck",
    playerId: null,
    callsign: null,
    classId: args.classId,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: { ...args.pos },
    vel: { x: 0, y: 0, z: 0 },
    quat: args.quat ? { ...args.quat } : { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    onPad: null,
    wreckExpiresAt: args.wreckExpiresAt,
  };
}

/**
 * TASK-31: mint an on-foot character entity. The character lives
 * next to the owning player's docked ship (TASK-29 dock state is
 * the precondition for disembark per the spec) and carries the
 * `onShipId` so re-entry (TASK-35) can find the ship without a
 * second lookup.
 *
 * Characters are first-class sim entities (not client-side
 * illusions) so on-foot multiplayer (TASK-36) reuses the same
 * broadcast loop and persistence reuses the ship pattern. v1 ships
 * idle — no integration happens until TASK-32 wires walk/look.
 *
 * `id` is conventionally `char:<playerId>` so the entity id is
 * stable across reconnect (the renderer can dedupe by id and the
 * presence broadcast can reference the character without an extra
 * round-trip).
 */
export function makeCharacterEntity(args: {
  id: string;
  playerId: string;
  callsign: string;
  shipId: string;
  pos: { x: number; y: number; z: number };
  vel?: { x: number; y: number; z: number };
  quat?: { x: number; y: number; z: number; w: number };
  regime?: SimEntity["regime"];
  originPlanetId?: string | null;
  onPad?: string | null;
}): SimEntity {
  return {
    id: args.id,
    kind: "character",
    playerId: args.playerId,
    callsign: args.callsign,
    // Characters carry no ship class — the wire uses `classId: null`.
    classId: null,
    // Hull + shields are unused on characters (TASK-32 may repurpose
    // them for stamina) but the field is mandatory on `SimEntity`.
    hull: 0,
    shields: 0,
    targetId: null,
    pos: { ...args.pos },
    vel: args.vel ? { ...args.vel } : { x: 0, y: 0, z: 0 },
    quat: args.quat ? { ...args.quat } : { x: 0, y: 0, z: 0, w: 1 },
    regime: args.regime ?? "surface",
    originPlanetId: args.originPlanetId ?? null,
    // The ship's `onPad` is the character's `onPad` at the moment of
    // disembark; the renderer keeps showing the prompt until the
    // character moves away (TASK-32 will add distance culling).
    onPad: args.onPad ?? null,
    onShipId: args.shipId,
    characterOnPad: args.onPad ?? null,
  };
}

/**
 * Convert a `SimEntity` to the wire `EntityState` shape used by
 * `entity_update`. Centralised so the broadcast loop and the tests
 * share the same serializer and the wire contract is impossible to
 * break in just one place.
 *
 * TASK-31: characters carry `classId: null` + `onFoot: true` on
 * the wire. The `onPad` field is preserved verbatim so the HUD
 * can show the "Ship is docked here" prompt near the character.
 */
export function entityToWire(e: SimEntity): ProtocolEntityState {
  if (e.kind === "character") {
    return {
      id: e.id,
      kind: "character",
      pos: [e.pos.x, e.pos.y, e.pos.z],
      vel: [e.vel.x, e.vel.y, e.vel.z],
      regime:
        e.regime === "atmosphere" ? "atmosphere" : e.regime === "surface" ? "surface" : "space",
      hull: 0,
      shields: 0,
      targetId: null,
      // Characters are not ships — `classId` is null on the wire.
      classId: null,
      callsign: e.callsign,
      livery: null,
      onPad: e.characterOnPad ?? null,
      onFoot: true,
    };
  }
  // TASK-33: deposit / terminal entities — broadcast-only, no
  // ship / character fields are meaningful. `classId` is null.
  if (e.kind === "deposit" || e.kind === "terminal") {
    return {
      id: e.id,
      kind: e.kind,
      pos: [e.pos.x, e.pos.y, e.pos.z],
      vel: [e.vel.x, e.vel.y, e.vel.z],
      regime:
        e.regime === "atmosphere" ? "atmosphere" : e.regime === "surface" ? "surface" : "space",
      hull: 0,
      shields: 0,
      targetId: null,
      classId: null,
      callsign: null,
      livery: null,
      onPad: null,
    };
  }
  return {
    id: e.id,
    kind: e.kind === "player" ? "ship" : e.kind === "ai" ? "ai-ship" : "wreck",
    pos: [e.pos.x, e.pos.y, e.pos.z],
    vel: [e.vel.x, e.vel.y, e.vel.z],
    regime: e.regime === "atmosphere" ? "atmosphere" : e.regime === "surface" ? "surface" : "space",
    hull: e.hull,
    shields: e.shields,
    targetId: e.targetId,
    classId: e.classId,
    callsign: e.callsign,
    livery: null,
    // TASK-29: pad id when the entity is docked. The persistence
    // layer and the sim tick both keep this field in sync — when
    // it's non-null the renderer shows the "DOCKED" HUD indicator
    // and the server treats the entity as a candidate for repair /
    // livery / cargo routes.
    onPad: e.onPad,
  };
}

/**
 * TASK-31: stable per-player character id. Format `char:<playerId>`
 * so the same id is returned across reconnect and so the broadcast
 * loop can dedupe by id without a secondary index.
 */
export function makeCharacterId(playerId: string): string {
  return `char:${playerId}`;
}

/**
 * TASK-31: lateral offset from the ship's centre to the character
 * spawn point. The offset is along the ship's local +X axis (the
 * "right" side in ship-local coordinates — a perpendicular to the
 * ship's forward in the pad plane), which keeps the character on
 * the pad regardless of the ship's heading.
 *
 * The pad surface is the ship pos projected onto the ground plane
 * (i.e. y stays put — the pad is level). The implementation copies
 * the existing ship `pos` then adds the rotated offset.
 */
export function characterSpawnPos(ship: SimEntity): Vec3 {
  const offsetWorld = quatRotateVector(ship.quat, { x: CHARACTER_SIDE_OFFSET_M, y: 0, z: 0 });
  return {
    x: ship.pos.x + offsetWorld.x,
    y: ship.pos.y,
    z: ship.pos.z + offsetWorld.z,
  };
}

/**
 * Generate a stable wreck entity id (TASK-23). Stable per destroyed
 * ship so reconnect + presence code can dedupe by id. Format:
 * `wreck:<sourceEntityId>`. Bumping this convention requires a
 * migration; the v1 shape is committed to TASK-23.
 */
export function makeWreckId(sourceEntityId: string): string {
  return `wreck:${sourceEntityId}`;
}
