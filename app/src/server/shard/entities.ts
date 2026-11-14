import type { SystemGen } from '@shared/galaxy/types.ts';
import type { FlightInput, ShipState } from '@shared/physics/flightTypes.ts';
import { bodiesOf } from '@shared/physics/bodies.ts';
import { dockOrientation, findDock } from '@shared/physics/docking.ts';
import { SYSTEM_FRAME } from '@shared/physics/frames.ts';
import { distance } from '@shared/physics/vec.ts';
import type { ServerPayload } from '@shared/protocol/registry.ts';
import type { ShipClassId } from '@shared/ships/ids.ts';
import type { Livery } from '@shared/ships/livery.ts';
import type { Ship, ShipStateUpdate } from '../db/types.ts';

export type EntityState = ServerPayload<'entity_update'>['entities'][number];

/** A ship living in a shard: persisted identity plus its simulated state and pending input. */
export interface ShipEntity {
  id: string;
  ownerId: string;
  callsign: string;
  classId: ShipClassId;
  livery: Livery;
  hull: number;
  shields: number;
  state: ShipState;
  /** Latest input from the owner (latest wins within a tick). */
  input: FlightInput;
  /** One-shot dock/undock command, held until a tick consumes it. */
  pendingAction: FlightInput['action'];
  /** Newest input seq applied; echoed to the owner for reconciliation. */
  lastSeq: number;
  /** True when the state changed since it was last saved. */
  dirty: boolean;
}

export const IDLE_INPUT: FlightInput = {
  thrust: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  up: 0,
  brake: false,
  action: 'none',
};

/** Range within which a ship saved as docked is re-attached to a dock on load. */
const REDOCK_RANGE_M = 200;

/** A ship's state when held at dock `dockId`: at its position, stopped, in berth orientation. */
function berthed(system: SystemGen, dockId: string): ShipState | undefined {
  const found = findDock(bodiesOf(system), dockId);
  if (!found) return undefined;
  return {
    frame: SYSTEM_FRAME,
    pos: found.dock.position,
    vel: { x: 0, y: 0, z: 0 },
    quat: dockOrientation(found.body, found.dock),
    regime: 'space',
    dockedAt: dockId,
  };
}

/** The system's first orbital dock, where ships without a usable saved position appear. */
function spawnDock(system: SystemGen) {
  for (const planet of system.planets) {
    const dock = planet.docks[0];
    if (dock) return dock;
  }
  return undefined;
}

/**
 * Initial sim state for a persisted ship entering `system`: its saved position when that lies in
 * this system (re-docked if it was saved docked next to a dock), otherwise docked at the
 * system's first dock. Orientation is not persisted yet and starts as identity.
 */
export function initialShipState(ship: Ship, system: SystemGen): ShipState {
  const base = {
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: 'space' as const,
  };
  const saved = ship.position;
  if (saved.systemId === system.systemId) {
    const pos = { x: saved.x, y: saved.y, z: saved.z };
    if (ship.state !== 'docked' || saved.frame !== SYSTEM_FRAME) {
      return { ...base, frame: saved.frame, pos, vel: ship.velocity };
    }
    const docks = system.planets.flatMap((planet) => planet.docks);
    const near = docks.find((dock) => distance(dock.position, pos) <= REDOCK_RANGE_M);
    const redocked = near && berthed(system, near.id);
    if (redocked) return redocked;
    // Saved as docked but not at a dock (a fresh starter ship): use the system's spawn dock.
  }
  const dock = spawnDock(system);
  const spawned = dock && berthed(system, dock.id);
  if (spawned) return spawned;
  // A system without docks (never a home system): park well clear of the star.
  return { ...base, frame: SYSTEM_FRAME, pos: { x: 0, y: system.star.radius * 3, z: 0 } };
}

/** The wire shape of a ship entity. */
export function toEntityState(entity: ShipEntity): EntityState {
  const { state } = entity;
  return {
    id: entity.id,
    kind: 'ship',
    pos: { frame: state.frame, x: state.pos.x, y: state.pos.y, z: state.pos.z },
    vel: state.vel,
    quat: state.quat,
    regime: state.regime,
    hull: entity.hull,
    shields: entity.shields,
    targetId: null,
    classId: entity.classId,
    callsign: entity.callsign,
    livery: entity.livery,
    ...(state.dockedAt ? { dockedAt: state.dockedAt } : {}),
    ...(state.onPad ? { onPad: state.onPad } : {}),
  };
}

/** What gets written to the ships table for an entity. */
export function toShipUpdate(entity: ShipEntity, systemId: string): ShipStateUpdate {
  const { state } = entity;
  return {
    hull: entity.hull,
    shields: entity.shields,
    position: { systemId, frame: state.frame, x: state.pos.x, y: state.pos.y, z: state.pos.z },
    velocity: state.vel,
    state: state.dockedAt || state.onPad ? 'docked' : 'flying',
  };
}
