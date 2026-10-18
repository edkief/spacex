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
import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";
import type { ProtocolEntityState, ProtocolShipClassId } from "@shared/protocol/index.js";

import type { SimEntity } from "./types.js";

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
 * Convert a `SimEntity` to the wire `EntityState` shape used by
 * `entity_update`. Centralised so the broadcast loop and the tests
 * share the same serializer and the wire contract is impossible to
 * break in just one place.
 */
export function entityToWire(e: SimEntity): ProtocolEntityState {
  return {
    id: e.id,
    kind:
      e.kind === "player"
        ? "ship"
        : e.kind === "ai"
          ? "ai-ship"
          : e.kind === "wreck"
            ? "wreck"
            : "character",
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
 * Generate a stable wreck entity id (TASK-23). Stable per destroyed
 * ship so reconnect + presence code can dedupe by id. Format:
 * `wreck:<sourceEntityId>`. Bumping this convention requires a
 * migration; the v1 shape is committed to TASK-23.
 */
export function makeWreckId(sourceEntityId: string): string {
  return `wreck:${sourceEntityId}`;
}
