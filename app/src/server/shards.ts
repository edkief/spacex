import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { encodeMessage } from '@shared/protocol';
import type { EntityState } from '@shared/protocol/schemas';
import { shipStats, type Livery, type ShipClass } from '@shared/ships';
import type { Repository, ShipPosition } from '@server/db/repo';
import type { Conn } from '@server/ws';
import type { InputPayload } from '@shared/protocol/schemas';
import type { SystemShard } from './shard';

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

/** TASK-21: a persisted livery change for a player's ship. */
export interface LiveryChangedEvent {
  playerId: string;
  livery: Livery;
}

export interface ShipSwapBus {
  emitSwap(event: ShipSwapEvent): void;
  /** Subscribe to swaps; returns an unsubscribe function. */
  onSwap(handler: (event: ShipSwapEvent) => void | Promise<void>): () => void;
  /** TASK-21: notify the player's system shard of a livery change. */
  emitLivery(event: LiveryChangedEvent): void;
  /** Subscribe to livery changes; returns an unsubscribe function. */
  onLivery(handler: (event: LiveryChangedEvent) => void | Promise<void>): () => void;
}

/** One bus per process; handlers are async-safe (rejections never crash). */
export function createShipSwapBus(): ShipSwapBus {
  const ee = new EventEmitter();
  ee.setMaxListeners(32);
  const subscribe =
    <E>(kind: string, label: string) =>
    (handler: (event: E) => void | Promise<void>): (() => void) => {
      const wrapped = (event: unknown): void => {
        Promise.resolve(handler(event as E)).catch((err) => {
          console.error(`${label} handler failed`, err);
        });
      };
      ee.on(kind, wrapped);
      return () => ee.off(kind, wrapped);
    };
  return {
    emitSwap(event) {
      ee.emit('swap', event);
    },
    onSwap: subscribe<ShipSwapEvent>('swap', 'ship-swap'),
    emitLivery(event) {
      ee.emit('livery', event);
    },
    onLivery: subscribe<LiveryChangedEvent>('livery', 'ship-livery'),
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
 * Wire the ship-swap bus to the WS connection table. Two events reach the
 * wire: on a swap, the player's ship entity is replaced in place; on a
 * livery change (TASK-21), the persisted ship re-emits as `entity_update`
 * with the new colors. Both go to every authenticated peer in that system.
 * The entity identity is stable per player (first swap takes over the
 * scrubbed ship's id — the id clients currently hold — and livery updates
 * reuse the same map), which is the in-place semantics the real shard
 * (TASK-12) must preserve.
 * Returns an unsubscribe function for both subscriptions.
 */
export function attachShipSwapBroadcast(
  bus: ShipSwapBus,
  connections: ReadonlySet<Conn> | Iterable<Conn>,
  repo: Pick<Repository, 'getPlayersByIds' | 'getShipByOwner'>,
): () => void {
  const peers: Iterable<Conn> = connections;
  /** playerId → entity id, stable across swaps and livery updates. */
  const entityIds = new Map<string, string>();

  async function broadcast(
    ship: ShipRowLike,
    cls: ShipClass,
    playerId: string,
    entityId: string,
    callsign: string | undefined,
  ): Promise<void> {
    const entity = shipToEntity(ship, cls, entityId);
    if (callsign) entity.callsign = callsign;
    for (const conn of peers) {
      if (conn.stage !== 'authed' || conn.systemId !== ship.position.systemId) continue;
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      conn.socket.send(encodeMessage('entity_update', { entities: [entity] }));
    }
  }

  const offSwap = bus.onSwap(async ({ playerId, ship, oldShipId }) => {
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
    await broadcast(ship, cls, playerId, entityId, player.callsign);
  });

  const offLivery = bus.onLivery(async ({ playerId, livery }) => {
    const ship = await repo.getShipByOwner(playerId);
    if (!ship) return; // sold/scrubbed in the meantime
    let cls: ShipClass;
    try {
      cls = shipStats(ship.classId);
    } catch {
      return;
    }
    const [player] = await repo.getPlayersByIds([playerId]);
    if (!player) return;
    const entityId = entityIds.get(playerId) ?? ship.id;
    entityIds.set(playerId, entityId);
    await broadcast({ ...ship, livery }, cls, playerId, entityId, player.callsign);
  });

  return () => {
    offSwap();
    offLivery();
  };
}

/**
 * TASK-31: route one VALIDATED gameplay frame to the shard the connection
 * is in (single writer: the shard mutates, the WS layer never does). Used by
 * the production entry (index.ts) and by the live-ws tests verbatim, so the
 * dispatch surface has one definition.
 *
 * - 'input'      → the per-tick input queue (stale-seq / stale-conn guarded);
 * - 'chat'       → ts + ring buffer + whole-shard broadcast;
 * - 'exit_ship'  → disembark (TASK-31): pad-docked check, character spawn,
 *                  'not-docked' denial on the requesting connection;
 * - 'interact'   → on-foot interaction (TASK-33): regime/target/range
 *                  validation, then dispatch by target kind (pickup /
 *                  terminal 'ui-open' / the ship branch delegates to the
 *                  enter-ship handler; TASK-34: ground items do the partial
 *                  inventory pickup);
 * - 'drop'       → on-foot drop (TASK-34): weight-capped inventory →
 *                  groundItem entity at the character's position;
 * - 'enter_ship' → re-entry (TASK-35): ownership / idempotency / 5 m range /
 *                  < 1 u/s speed validation, character → ship switch.
 */
export function routeGameMessage(
  shard: SystemShard,
  conn: Conn,
  type: string,
  payload: unknown,
): void {
  if (!conn.playerId) return;
  if (type === 'input') {
    shard.enqueueInput(conn.playerId, payload as InputPayload, conn);
  } else if (type === 'chat' && conn.callsign) {
    shard.handleChat(conn.callsign, (payload as { text: string }).text);
  } else if (type === 'exit_ship') {
    shard.handleExitShip(conn.playerId, (payload as { shipId: string }).shipId, conn);
  } else if (type === 'interact') {
    const p = payload as { targetId: string; action?: string };
    shard.handleInteract(conn.playerId, p.targetId, p.action, conn);
  } else if (type === 'drop') {
    const p = payload as { resourceId: string; amount: number };
    shard.handleDrop(conn.playerId, p.resourceId, p.amount, conn);
  } else if (type === 'enter_ship') {
    shard.handleEnterShip(conn.playerId, (payload as { shipId: string }).shipId, conn);
  } else if (type === 'cargo_open') {
    // TASK-39: ship-HUD 'Cargo' button (in flight / docked) — the server
    // answers the requester with the 'cargo' frame (hold only in flight).
    shard.handleCargoOpen(conn.playerId, conn);
  } else if (type === 'cargo_transfer') {
    // TASK-39: docked transfer (on foot, within 5 m of the own ship) —
    // docked + ownership + amounts validated in one step; the 'cargo'
    // frame answers the requester.
    const p = payload as { resourceId: string; amount: number; from: 'inv' | 'hold' };
    shard.handleCargoTransfer(conn.playerId, p, conn);
  } else if (type === 'sell') {
    // TASK-40: the WS alias of POST /api/ships/sell — the SAME handler
    // (shard.handleSell) the route delegates to. Docked + source-specific
    // station proximity validated in one step; the 'sell' result frame
    // (new stacks + balance) answers the requester.
    const p = payload as { resourceId: string; amount: number; source: 'hold' | 'inv' };
    void shard.handleSell(conn.playerId, p, conn);
  }
}
