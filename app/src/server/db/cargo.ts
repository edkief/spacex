import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RepoContext } from './context.ts';
import { NotFoundError } from './errors.ts';
import type { CargoItem, CargoRepo } from './types.ts';

const itemsSchema = z
  .array(
    z.strictObject({
      resourceType: z.string().min(1),
      quantity: z.number().int().min(0).max(2_147_483_647),
    }),
  )
  .refine((items) => new Set(items.map((i) => i.resourceType)).size === items.length, {
    error: 'duplicate resourceType in cargo list',
  });

/** Cargo aggregate: a ship's hold, replaced whole in one transaction. */
export function cargoRepo(ctx: RepoContext): CargoRepo {
  const { cargoItems, ships } = ctx.t;

  async function getCargoForShips(shipIds: readonly string[]): Promise<Map<string, CargoItem[]>> {
    const result = new Map<string, CargoItem[]>(shipIds.map((id) => [id, []]));
    if (shipIds.length === 0) return result;
    const rows = await ctx.run((db) =>
      db
        .select()
        .from(cargoItems)
        .where(inArray(cargoItems.shipId, [...shipIds]))
        .orderBy(asc(cargoItems.resourceType)),
    );
    for (const row of rows) {
      result.get(row.shipId)?.push({ resourceType: row.resourceType, quantity: row.quantity });
    }
    return result;
  }

  return {
    getCargoForShips,

    async getCargo(shipId) {
      return (await getCargoForShips([shipId])).get(shipId) ?? [];
    },

    async saveCargo(shipId, items) {
      const parsed = itemsSchema.parse(items);
      const kept = parsed.filter((item) => item.quantity > 0);
      await ctx.transaction(async (tx) => {
        const ship = await tx.run((db) =>
          db.select({ id: ships.id }).from(ships).where(eq(ships.id, shipId)).limit(1),
        );
        if (!ship[0]) throw new NotFoundError('ship', shipId);

        const keptTypes = kept.map((item) => item.resourceType);
        await tx.run((db) =>
          db
            .delete(cargoItems)
            .where(
              keptTypes.length === 0
                ? eq(cargoItems.shipId, shipId)
                : and(
                    eq(cargoItems.shipId, shipId),
                    notInArray(cargoItems.resourceType, keptTypes),
                  ),
            ),
        );
        if (kept.length === 0) return;
        await tx.run((db) =>
          db
            .insert(cargoItems)
            .values(kept.map((item) => ({ id: tx.newId(), shipId, ...item })))
            .onConflictDoUpdate({
              target: [cargoItems.shipId, cargoItems.resourceType],
              set: { quantity: sql`excluded.quantity` },
            }),
        );
      });
    },
  };
}
