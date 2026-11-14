import type { SystemGen } from '@shared/galaxy/types.ts';
import { bodiesOf, type Body } from '@shared/physics/bodies.ts';
import type { FlightWorld } from '@shared/physics/flightTypes.ts';
import { stepShip } from '@shared/physics/stepShip.ts';
import type { ClientPayload, ServerPayload } from '@shared/protocol/registry.ts';
import { shipStats } from '@shared/ships/catalog.ts';
import type { Repository } from '../db/types.ts';
import type { DirectoryPlayer, PlayerSink } from '../directory.ts';
import {
  IDLE_INPUT,
  initialShipState,
  toEntityState,
  toShipUpdate,
  type ShipEntity,
} from './entities.ts';
import { SurfaceAccess } from './terrain.ts';

export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
/** Entity updates go out every this many ticks (10 Hz). */
export const SNAPSHOT_EVERY = 2;
/** Dirty ships are saved every this many ticks (5 s). */
export const SAVE_EVERY = 100;

interface Member {
  playerId: string;
  callsign: string;
  shipId: string;
  sinks: Set<PlayerSink>;
}

export interface ShardOptions {
  seed: string;
  system: SystemGen;
  repo: Repository;
  onError?: (error: unknown) => void;
}

type StateSnapshot = ServerPayload<'state_snapshot'>;

/**
 * One star system's authoritative simulation. All entity mutation happens in `tick` (a single
 * writer); message handlers only record the latest input. Ships stay in the sim when their
 * owner disconnects (idle input) and are saved on leave, on an interval and on shutdown.
 */
export class Shard {
  readonly systemId: string;
  tickNumber = 0;
  private readonly entities = new Map<string, ShipEntity>();
  private readonly members = new Map<string, Member>();
  private readonly bodies: readonly Body[];
  private readonly surface: SurfaceAccess;
  private readonly options: ShardOptions;

  constructor(options: ShardOptions) {
    this.options = options;
    this.systemId = options.system.systemId;
    this.bodies = bodiesOf(options.system);
    this.surface = new SurfaceAccess(options.seed, options.system);
  }

  get playerCount(): number {
    return this.members.size;
  }

  has(playerId: string): boolean {
    return this.members.has(playerId);
  }

  entity(shipId: string): ShipEntity | undefined {
    return this.entities.get(shipId);
  }

  /** Adds a player (or another socket of one already here), loading their ship if needed. */
  async join(player: DirectoryPlayer): Promise<StateSnapshot> {
    if (!this.entities.has(player.shipId)) {
      const ship = await this.options.repo.getShip(player.shipId);
      if (!ship) throw new Error(`ship ${player.shipId} does not exist`);
      if (!this.entities.has(player.shipId)) {
        this.entities.set(player.shipId, {
          id: ship.id,
          ownerId: player.playerId,
          callsign: player.callsign,
          classId: ship.classId,
          livery: ship.livery,
          hull: ship.hull,
          shields: ship.shields,
          state: initialShipState(ship, this.options.system),
          input: IDLE_INPUT,
          pendingAction: 'none',
          lastSeq: 0,
          dirty: true,
        });
      }
    }
    const existing = this.members.get(player.playerId);
    if (existing) {
      existing.sinks.add(player.sink);
    } else {
      const member: Member = { ...player, sinks: new Set([player.sink]) };
      this.broadcast('presence', {
        joined: [{ playerId: player.playerId, callsign: player.callsign, entityId: player.shipId }],
        left: [],
      });
      this.members.set(player.playerId, member);
    }
    return this.snapshot(player.playerId);
  }

  /** Removes one socket of a player; when it was their last, saves the ship and tells the rest. */
  async leave(playerId: string, sink?: PlayerSink): Promise<void> {
    const member = this.members.get(playerId);
    if (!member) return;
    if (sink) member.sinks.delete(sink);
    if (sink && member.sinks.size > 0) return;
    this.members.delete(playerId);
    const entity = this.entities.get(member.shipId);
    if (entity) entity.input = IDLE_INPUT;
    this.broadcast('presence', { joined: [], left: [playerId] });
    if (entity) await this.save([entity]);
  }

  /** Records a player's input; the next tick applies the latest one. Stale seqs are ignored. */
  input(playerId: string, input: ClientPayload<'input'>): void {
    const member = this.members.get(playerId);
    const entity = member && this.entities.get(member.shipId);
    if (!entity || input.seq <= entity.lastSeq) return;
    entity.lastSeq = input.seq;
    entity.input = input;
    if (input.action !== 'none') entity.pendingAction = input.action;
  }

  /** One fixed sim step for every ship, then a 10 Hz broadcast and a periodic save. */
  tick(): void {
    this.tickNumber += 1;
    const dt = TICK_MS / 1000;
    for (const entity of this.entities.values()) {
      const before = entity.state;
      const world: FlightWorld = {
        bodies: this.bodies,
        surface: (frame) => this.surface.provider(frame, before.pos),
      };
      const input = { ...entity.input, action: entity.pendingAction };
      entity.pendingAction = 'none';
      entity.state = stepShip(before, input, dt, world, shipStats(entity.classId));
      if (entity.state.pos !== before.pos || entity.state.dockedAt !== before.dockedAt) {
        entity.dirty = true;
      }
    }
    if (this.tickNumber % SNAPSHOT_EVERY === 0) this.broadcastEntities();
    if (this.tickNumber % SAVE_EVERY === 0) {
      void this.save([...this.entities.values()].filter((entity) => entity.dirty));
    }
  }

  private broadcastEntities(): void {
    if (this.members.size === 0) return;
    const entities = [...this.entities.values()].map(toEntityState);
    for (const member of this.members.values()) {
      const lastInputSeq = this.entities.get(member.shipId)?.lastSeq ?? 0;
      for (const sink of member.sinks) {
        sink.send('entity_update', { tick: this.tickNumber, lastInputSeq, entities });
      }
    }
  }

  private broadcast<K extends 'presence'>(type: K, payload: ServerPayload<K>): void {
    for (const member of this.members.values()) {
      for (const sink of member.sinks) sink.send(type, payload);
    }
  }

  /** Full state as seen by one player. */
  snapshot(playerId: string): StateSnapshot {
    const member = this.members.get(playerId);
    return {
      systemId: this.systemId,
      tick: this.tickNumber,
      lastInputSeq: (member && this.entities.get(member.shipId)?.lastSeq) ?? 0,
      entities: [...this.entities.values()].map(toEntityState),
      nodes: [],
      chat: [],
      players: [...this.members.values()].map((m) => ({
        playerId: m.playerId,
        callsign: m.callsign,
        entityId: m.shipId,
      })),
    };
  }

  /** Saves the given ships in one transaction; failures are reported and retried next time. */
  private async save(entities: readonly ShipEntity[]): Promise<void> {
    if (entities.length === 0) return;
    for (const entity of entities) entity.dirty = false;
    try {
      await this.options.repo.saveShipSnapshots(
        entities.map((entity) => ({
          shipId: entity.id,
          update: toShipUpdate(entity, this.systemId),
        })),
      );
    } catch (error) {
      for (const entity of entities) entity.dirty = true;
      this.options.onError?.(error);
    }
  }

  /** Saves every ship (shutdown and reaping). */
  async flush(): Promise<void> {
    await this.save([...this.entities.values()]);
  }
}
