import { db, schema } from './client';
import { 
  Player, 
  Ship, 
  CargoItem, 
  Session, 
  ResourceNodeState, 
  CallsignTakenError, 
  InsufficientCreditsError, 
  NotFoundError 
} from './types';
import { eq, sql } from 'drizzle-orm';
import crypto from 'crypto';

export class Repository {
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
    const result = await db.select().from(schema.players).where(eq(schema.players.callsign, callsign)).limit(1);
    return result[0] || null;
  }

  async getOrCreateStarterShip(playerId: string): Promise<Ship> {
    const existing = await db.select().from(schema.ships).where(eq(schema.ships.owner_id, playerId)).limit(1);
    if (existing.length > 0) return existing[0];

    const id = crypto.randomUUID();
    const now = new Date();
    const shipValues = {
      id,
      owner_id: playerId,
      class_id: 'starter',
      livery: JSON.stringify({}),
      hull: 100,
      shields: 100,
      position: JSON.stringify({ x: 0, y: 0, z: 0 }),
      velocity: JSON.stringify({ x: 0, y: 0, z: 0 }),
      state: 'docked',
      updated_at: now,
    };

    await db.insert(schema.ships).values(shipValues);
    
    return {
      ...shipValues,
      livery: {},
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    } as Ship;
  }

  async saveShipState(shipId: string, state: Partial<Ship>): Promise<void> {
    const updateValues: any = { ...state, updated_at: new Date() };
    
    if (updateValues.livery) updateValues.livery = JSON.stringify(updateValues.livery);
    if (updateValues.position) updateValues.position = JSON.stringify(updateValues.position);
    if (updateValues.velocity) updateValues.velocity = JSON.stringify(updateValues.velocity);

    const result = await db.update(schema.ships)
      .set(updateValues)
      .where(eq(schema.ships.id, shipId));
    
    if (result.length === 0) {
      const existing = await db.select().from(schema.ships).where(eq(schema.ships.id, shipId)).limit(1);
      if (existing.length === 0) {
        throw new NotFoundError('Ship', shipId);
      }
    }
  }

  async saveCargo(shipId: string, items: CargoItem[]): Promise<void> {
    await db.transaction((tx: any) => {
      tx.delete(schema.cargo_items).where(eq(schema.cargo_items.ship_id, shipId)).run();
      for (const item of items) {
        tx.insert(schema.cargo_items).values({
          ship_id: shipId,
          resource_type: item.resource_type,
          quantity: item.quantity,
        }).run();
      }
    });
  }

  async addCredits(playerId: string, amount: number): Promise<void> {
    await db.update(schema.players)
      .set({ credits: sql`${schema.players.credits} + ${amount}` })
      .where(eq(schema.players.id, playerId));
  }

  async withdrawCredits(playerId: string, amount: number): Promise<void> {
    const player = await db.select().from(schema.players).where(eq(schema.players.id, playerId)).limit(1);
    if (player.length === 0) throw new NotFoundError('Player', playerId);
    
    if (player[0].credits < amount) {
      throw new InsufficientCreditsError();
    }

    await db.update(schema.players)
      .set({ credits: sql`${schema.players.credits} - ${amount}` })
      .where(eq(schema.players.id, playerId));
  }

  async upsertNodeState(nodeId: string, quantity: number, respawnAt: Date | null): Promise<void> {
    const existing = await db.select().from(schema.resource_node_state).where(eq(schema.resource_node_state.node_id, nodeId)).limit(1);
    
    if (existing.length > 0) {
      await db.update(schema.resource_node_state)
        .set({ quantity_remaining: quantity, respawn_at: respawnAt })
        .where(eq(schema.resource_node_state.node_id, nodeId));
    } else {
      await db.insert(schema.resource_node_state).values({
        node_id: nodeId,
        quantity_remaining: quantity,
        respawn_at: respawnAt,
      });
    }
  }

  async listNodeStates(systemId: string): Promise<ResourceNodeState[]> {
    return await db.select().from(schema.resource_node_state);
  }

  async createSession(playerId: string, systemId: string | null): Promise<Session> {
    const token_hash = crypto.randomBytes(32).toString('hex');
    const created_at = new Date();
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);

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
    const result = await db.select().from(schema.sessions).where(eq(schema.sessions.token_hash, token_hash)).limit(1);
    return result[0] || null;
  }

  async deleteSession(token_hash: string): Promise<void> {
    await db.delete(schema.sessions).where(eq(schema.sessions.token_hash, token_hash));
  }
}

export const repo = new Repository();
