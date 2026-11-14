import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { shipStats } from '@shared/ships/catalog.ts';
import type { RepoContext } from './context.ts';
import { NotFoundError } from './errors.ts';
import type { Livery } from './json.ts';
import { shipStateUpdateSchema, toShip } from './shipRows.ts';
import type { Ship, ShipsRepo } from './types.ts';

export const STARTER_LIVERY: Livery = { hull: '#8899aa', accent: '#ff7a1a', trim: '#222831' };

/** Ship aggregate: lifecycle and mutable state (cargo lives in cargo.ts). */
export function shipsRepo(ctx: RepoContext): ShipsRepo {
  const { ships, players } = ctx.t;

  async function getShip(id: string): Promise<Ship | undefined> {
    const rows = await ctx.run((db) => db.select().from(ships).where(eq(ships.id, id)).limit(1));
    return rows[0] ? toShip(rows[0]) : undefined;
  }

  return {
    getShip,

    async getOrCreateStarterShip(playerId) {
      return ctx.transaction(async (tx) => {
        const owner = await tx.run((db) =>
          db.select().from(players).where(eq(players.id, playerId)).limit(1),
        );
        if (!owner[0]) throw new NotFoundError('player', playerId);
        await tx.run((db) => tx.handle.lockPlayer(db, playerId));

        const existing = await tx.run((db) =>
          db
            .select()
            .from(ships)
            .where(
              and(
                eq(ships.ownerId, playerId),
                eq(ships.classId, 'scout'),
                ne(ships.state, 'destroyed'),
              ),
            )
            .orderBy(asc(ships.id))
            .limit(1),
        );
        if (existing[0]) return toShip(existing[0]);

        const scout = shipStats('scout');
        const row = {
          id: tx.newId(),
          ownerId: playerId,
          classId: scout.id,
          livery: STARTER_LIVERY,
          hull: scout.hull,
          shields: scout.shieldCapacity,
          position: { systemId: owner[0].homeSystemId, frame: 'system' as const, x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          state: 'docked' as const,
          updatedAt: tx.now(),
        };
        const inserted = await tx.run((db) => db.insert(ships).values(row).returning());
        return toShip(inserted[0]!);
      });
    },

    async listShipsByOwner(ownerId) {
      const rows = await ctx.run((db) =>
        db.select().from(ships).where(eq(ships.ownerId, ownerId)).orderBy(asc(ships.id)),
      );
      return rows.map(toShip);
    },

    async listShipsInSystem(systemId) {
      const inSystem = sql`${ctx.handle.jsonText(ships.position, 'systemId')} = ${systemId}`;
      const rows = await ctx.run((db) =>
        db
          .select()
          .from(ships)
          .where(and(inSystem, ne(ships.state, 'destroyed')))
          .orderBy(asc(ships.id)),
      );
      return rows.map(toShip);
    },

    async saveShipState(shipId, update) {
      const parsed = shipStateUpdateSchema.parse(update);
      const { livery, ...rest } = parsed;
      const rows = await ctx.run((db) =>
        db
          .update(ships)
          .set({ ...rest, ...(livery ? { livery } : {}), updatedAt: ctx.now() })
          .where(eq(ships.id, shipId))
          .returning(),
      );
      if (!rows[0]) throw new NotFoundError('ship', shipId);
      return toShip(rows[0]);
    },
  };
}
