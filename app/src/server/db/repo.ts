import { db, schema } from './client';
import {
  Player,
  Ship,
  CargoItem,
  Session,
  ResourceNodeState,
  CallsignTakenError,
  InsufficientCreditsError,
  NotFoundError,
} from './types';
import { eq, sql, and, gte } from 'drizzle-orm';
import crypto from 'crypto';

export class Repository {
  private getDb(tx?: any) {
    return tx || db;
  }

  async createPlayer(callsign: string, homeSystemId: string): Promise<Player> {
    try {
      const id = crypto.randomUUID();
      const created_at = new Date();

      await db.insert(schema.players).values({
        id,
        callsign,
        home_system_id: homeSystemId,
        created_at,
      });

      return {
        id,
        callsign,
        credits: 500,
        home_system_id: homeSystemId,
        created_at,
      };
    } catch (e: any) {
      if (e.message?.includes('UNIQUE constraint failed') || e.code === '23505') {
        throw new CallsignTakenError(callsign);
      }
      throw e;
    }
  }

  async findPlayerByCallsign(callsign: string): Promise<Player | null> {
    const result = await db
      .select()
      .from(schema.players)
      .where(eq(schema.players.callsign, callsign))
      .limit(1);
    return result[0] || null;
  }

  async findPlayerById(id: string): Promise<Player | null> {
    const result = await db.select().from(schema.players).where(eq(schema.players.id, id)).limit(1);
    return result[0] || null;
  }

  async getOrCreateStarterShip(playerId: string, systemId: string): Promise<Ship> {
    const existing = await this.getDb()
      .select()
      .from(schema.ships)
      .where(eq(schema.ships.owner_id, playerId))
      .limit(1);
    if (existing.length > 0) return existing[0];

    const id = crypto.randomUUID();
    const now = new Date();
    const shipValues = {
      id,
      owner_id: playerId,
      class_id: 'scout',
      livery: JSON.stringify({}),
      hull: 100,
      shields: 100,
      position: JSON.stringify({ x: 0, y: 0, z: 0 }),
      velocity: JSON.stringify({ x: 0, y: 0, z: 0 }),
      system_id: systemId,
      state: 'docked',
      updated_at: now,
    };

    await this.getDb().insert(schema.ships).values(shipValues);

    return {
      ...shipValues,
      livery: {},
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    } as Ship;
  }

  async saveShipState(shipId: string, state: Partial<Ship>, tx?: any): Promise<void> {
    const updateValues: any = { ...state, updated_at: new Date() };

    if (updateValues.livery) updateValues.livery = JSON.stringify(updateValues.livery);
    if (updateValues.position) updateValues.position = JSON.stringify(updateValues.position);
    if (updateValues.velocity) updateValues.velocity = JSON.stringify(updateValues.velocity);

    const result = await this.getDb(tx)
      .update(schema.ships)
      .set(updateValues)
      .where(eq(schema.ships.id, shipId));

    if (result.length === 0) {
      const existing = await this.getDb(tx)
        .select()
        .from(schema.ships)
        .where(eq(schema.ships.id, shipId))
        .limit(1);
      if (existing.length === 0) {
        throw new NotFoundError('Ship', shipId);
      }
    }
  }

  async loadCargo(shipId: string, tx?: any): Promise<CargoItem[]> {
    return await this.getDb(tx)
      .select()
      .from(schema.cargo_items)
      .where(eq(schema.cargo_items.ship_id, shipId));
  }

  async saveCargo(shipId: string, items: CargoItem[], tx?: any): Promise<void> {
    const db = this.getDb(tx);

    if (tx) {
      await db.delete(schema.cargo_items).where(eq(schema.cargo_items.ship_id, shipId));
      for (const item of items) {
        await db.insert(schema.cargo_items).values({
          ship_id: shipId,
          resource_type: item.resource_type,
          quantity: item.quantity,
        });
      }
    } else {
      // For better-sqlite3, transaction callback must be synchronous
      await db.transaction((tx: any) => {
        tx.delete(schema.cargo_items).where(eq(schema.cargo_items.ship_id, shipId)).run();
        for (const item of items) {
          tx.insert(schema.cargo_items)
            .values({
              ship_id: shipId,
              resource_type: item.resource_type,
              quantity: item.quantity,
            })
            .run();
        }
      });
    }
  }

  async addCredits(playerId: string, amount: number, tx?: any): Promise<void> {
    if (tx) {
      this.getDb(tx)
        .update(schema.players)
        .set({ credits: sql`${schema.players.credits} + ${amount}` })
        .where(eq(schema.players.id, playerId))
        .run();
    } else {
      await this.getDb()
        .update(schema.players)
        .set({ credits: sql`${schema.players.credits} + ${amount}` })
        .where(eq(schema.players.id, playerId));
    }
  }

  async deleteShip(shipId: string, tx?: any): Promise<void> {
    if (tx) {
      this.getDb(tx).delete(schema.cargo_items).where(eq(schema.cargo_items.ship_id, shipId)).run();
      this.getDb(tx).delete(schema.ships).where(eq(schema.ships.id, shipId)).run();
    } else {
      await this.getDb().delete(schema.cargo_items).where(eq(schema.cargo_items.ship_id, shipId));
      await this.getDb().delete(schema.ships).where(eq(schema.ships.id, shipId));
    }
  }

  deleteShipSync(shipId: string, tx: any): void {
    this.getDb(tx).delete(schema.cargo_items).where(eq(schema.cargo_items.ship_id, shipId)).run();
    this.getDb(tx).delete(schema.ships).where(eq(schema.ships.id, shipId)).run();
  }

  async getShipByOwner(playerId: string, tx?: any): Promise<Ship | null> {
    const result = await this.getDb(tx)
      .select()
      .from(schema.ships)
      .where(eq(schema.ships.owner_id, playerId))
      .limit(1);
    return result[0] || null;
  }

  async createShip(ship: Partial<Ship>, tx?: any): Promise<Ship> {
    const id = crypto.randomUUID();
    const now = new Date();
    const shipValues = {
      ...ship,
      id,
      updated_at: now,
      livery: typeof ship.livery === 'object' ? JSON.stringify(ship.livery) : ship.livery,
      position: typeof ship.position === 'object' ? JSON.stringify(ship.position) : ship.position,
      velocity: typeof ship.velocity === 'object' ? JSON.stringify(ship.velocity) : ship.velocity,
    };

    if (tx) {
      this.getDb(tx).insert(schema.ships).values(shipValues).run();
    } else {
      await this.getDb().insert(schema.ships).values(shipValues);
    }

    return {
      ...shipValues,
      id,
      updated_at: now,
      livery: ship.livery,
      position: ship.position,
      velocity: ship.velocity,
    } as Ship;
  }

  createShipSync(ship: Partial<Ship>, tx: any): Ship {
    const id = crypto.randomUUID();
    const now = new Date();
    const shipValues = {
      ...ship,
      id,
      updated_at: now,
      livery: typeof ship.livery === 'object' ? JSON.stringify(ship.livery) : ship.livery,
      position: typeof ship.position === 'object' ? JSON.stringify(ship.position) : ship.position,
      velocity: typeof ship.velocity === 'object' ? JSON.stringify(ship.velocity) : ship.velocity,
    };

    this.getDb(tx).insert(schema.ships).values(shipValues).run();

    return {
      ...shipValues,
      id,
      updated_at: now,
      livery: ship.livery,
      position: ship.position,
      velocity: ship.velocity,
    } as Ship;
  }

  async withdrawCredits(playerId: string, amount: number, tx?: any): Promise<void> {
    if (tx) {
      const result = this.getDb(tx)
        .update(schema.players)
        .set({ credits: sql`${schema.players.credits} - ${amount}` })
        .where(and(eq(schema.players.id, playerId), gte(schema.players.credits, amount)))
        .run();

      if (
        !result ||
        (typeof result === 'number' && result === 0) ||
        (typeof result === 'object' && result.changes === 0)
      ) {
        throw new InsufficientCreditsError();
      }
    } else {
      const result = await this.getDb()
        .update(schema.players)
        .set({ credits: sql`${schema.players.credits} - ${amount}` })
        .where(and(eq(schema.players.id, playerId), gte(schema.players.credits, amount)));

      if (
        !result ||
        (typeof result === 'number' && result === 0) ||
        (typeof result === 'object' && result.changes === 0)
      ) {
        const player = await this.getDb()
          .select()
          .from(schema.players)
          .where(eq(schema.players.id, playerId))
          .limit(1);
        if (player.length === 0) throw new NotFoundError('Player', playerId);
        throw new InsufficientCreditsError();
      }
    }
  }

  withdrawCreditsSync(playerId: string, amount: number, tx: any): void {
    const result = this.getDb(tx)
      .update(schema.players)
      .set({ credits: sql`${schema.players.credits} - ${amount}` })
      .where(and(eq(schema.players.id, playerId), gte(schema.players.credits, amount)))
      .run();

    if (
      !result ||
      (typeof result === 'number' && result === 0) ||
      (typeof result === 'object' && result.changes === 0)
    ) {
      throw new InsufficientCreditsError();
    }
  }

  async upsertNodeState(
    nodeId: string,
    systemId: string,
    quantity: number,
    respawnAt: Date | null,
    tx?: any,
  ): Promise<void> {
    const db = this.getDb(tx);
    const existing = await db
      .select()
      .from(schema.resource_node_state)
      .where(eq(schema.resource_node_state.node_id, nodeId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(schema.resource_node_state)
        .set({ quantity_remaining: quantity, respawn_at: respawnAt })
        .where(eq(schema.resource_node_state.node_id, nodeId));
    } else {
      await db.insert(schema.resource_node_state).values({
        node_id: nodeId,
        system_id: systemId,
        quantity_remaining: quantity,
        respawn_at: respawnAt,
      });
    }
  }

  async listNodeStates(systemId: string, tx?: any): Promise<ResourceNodeState[]> {
    return await this.getDb(tx)
      .select()
      .from(schema.resource_node_state)
      .where(eq(schema.resource_node_state.system_id, systemId));
  }

  async loadSystemState(systemId: string): Promise<{ ships: Ship[]; nodes: ResourceNodeState[] }> {
    const ships = await db.select().from(schema.ships).where(eq(schema.ships.system_id, systemId));
    const nodes = await this.listNodeStates(systemId);
    return { ships, nodes };
  }

  async createSession(
    playerId: string,
    systemId: string | null,
    token_hash: string,
  ): Promise<Session> {
    const created_at = new Date();
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days as per spec

    await db.insert(schema.sessions).values({
      token_hash,
      player_id: playerId,
      system_id: systemId,
      created_at,
      expires_at,
    });

    return { token_hash, player_id: playerId, system_id: systemId, created_at, expires_at };
  }

  async findSession(token_hash: string): Promise<Session | null> {
    const result = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.token_hash, token_hash))
      .limit(1);
    return result[0] || null;
  }

  async deleteSession(token_hash: string): Promise<void> {
    await db.delete(schema.sessions).where(eq(schema.sessions.token_hash, token_hash));
  }
}

export const repo = new Repository();
