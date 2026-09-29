import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { encodeMessage } from '@shared/protocol';
import type { EntityState } from '@shared/protocol/schemas';
import { shipStats, type ShipClass } from '@shared/ships';
import type { Repository, ShipPosition } from '@server/db/repo';
import type { Conn } from '@server/ws';

/**
 * In-process ship-swap channel (TASK-20). Shards are single-process (PRD §7),
 * so a plain EventEmitter bus is the notification path: the dock-purchase
 * route emits after its transaction commits; the active system shard listens.
 *
 * This file also hosts the minimal entity bridge: it maps a persisted ship
 * row to a protocol EntityState and broadcasts `entity_update` to every
 * authenticated connection sitting in that system. TASK-11/12 folds this
 * into the real shard lifecycle; the broadcast contract is already the one
 * the shard will use.
 */

export interface ShipSwapEvent {
  playerId: string;
  /** The new ship: docked, full hull/shields, default livery. */
  ship: ShipRowLike;
  /** The scrubbed ship's id — the entity id currently visible in-system. */
  oldShipId: string;
}

/** The fields the entity mapping needs; the repo's ShipRow satisfies this. */
export interface ShipRowLike {
  id: string;
  classId: string;
  livery: Record<string, unknown>;
  hull: number;
  shields: number;
  position: ShipPosition;
  velocity: { x: number; y: number; z: number };
  state: 'docked' | 'flying' | 'onfoot' | 'destroyed';
}

export interface ShipSwapBus {
  emitSwap(event: ShipSwapEvent): void;
  /** Subscribe to swaps; returns an unsubscribe function. */
  onSwap(handler: (event: ShipSwapEvent) => void | Promise<void>): () => void;
}

/** One bus per process; handlers are async-safe (rejections never crash). */
export function createShipSwapBus(): ShipSwapBus {
  const ee = new EventEmitter();
  ee.setMaxListeners(32);
  return {
    emitSwap(event) {
      ee.emit('swap', event);
    },
    onSwap(handler) {
      const wrapped = (event: ShipSwapEvent): void => {
        Promise.resolve(handler(event)).catch((err) => {
          console.error('ship-swap handler failed', err);
        });
      };
      ee.on('swap', wrapped);
      return () => ee.off('swap', wrapped);
    },
  };
}

const LIVERY_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Persisted ship row → protocol EntityState. Hull/shields are normalized to
 * 0..1 against the class caps; the entity id may be overridden so a swap can
 * replace the in-system entity in place (same id, new class stats).
 */
export function shipToEntity(ship: ShipRowLike, cls: ShipClass, entityId?: string): EntityState {
  const entity: EntityState = {
    id: entityId ?? ship.id,
    kind: 'ship',
    pos: { x: ship.position.x, y: ship.position.y, z: ship.position.z },
    vel: { x: ship.velocity.x, y: ship.velocity.y, z: ship.velocity.z },
    regime: ship.state === 'docked' ? 'docked' : 'sublight',
    hull: Math.min(1, cls.hull > 0 ? ship.hull / cls.hull : 0),
    shields: Math.min(1, cls.shieldCapacity > 0 ? ship.shields / cls.shieldCapacity : 0),
    targetId: null,
    classId: cls.id,
  };
  const livery: Record<string, string> = {};
  for (const [key, value] of Object.entries(ship.livery ?? {})) {
    if (typeof value === 'string' && LIVERY_COLOR.test(value)) livery[key] = value;
  }
  if (Object.keys(livery).length > 0) entity.livery = livery;
  return entity;
}

/**
 * Wire the ship-swap bus to the WS connection table: on a swap, replace the
 * player's ship entity in place and broadcast `entity_update` to every
 * authenticated peer in that system. The entity identity is stable per
 * player (first swap takes over the scrubbed ship's id — the id clients
 * currently hold — and keeps it across later swaps), which is the in-place
 * semantics the real shard (TASK-12) must preserve.
 * Returns an unsubscribe function.
 */
export function attachShipSwapBroadcast(
  bus: ShipSwapBus,
  connections: ReadonlySet<Conn> | Iterable<Conn>,
  repo: Pick<Repository, 'getPlayersByIds'>,
): () => void {
  const peerSets: Iterable<Conn> = connections;
  /** playerId → entity id, stable across swaps (in-place replacement). */
  const entityIds = new Map<string, string>();
  return bus.onSwap(async ({ playerId, ship, oldShipId }) => {
    let cls: ShipClass;
    try {
      cls = shipStats(ship.classId);
    } catch {
      return; // unknown class id never crosses the wire
    }
    const [player] = await repo.getPlayersByIds([playerId]);
    if (!player) return;
    const entityId = entityIds.get(playerId) ?? oldShipId;
    entityIds.set(playerId, entityId);
    const entity = shipToEntity(ship, cls, entityId);
    entity.callsign = player.callsign;
    for (const conn of peerSets) {
      if (conn.stage !== 'authed' || conn.systemId !== ship.position.systemId) continue;
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      conn.socket.send(encodeMessage('entity_update', { entities: [entity] }));
    }
  });
}
