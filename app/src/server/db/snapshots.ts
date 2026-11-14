import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { cargoItemsSchema } from './cargo.ts';
import type { RepoContext } from './context.ts';
import { shipStateUpdateSchema } from './shipRows.ts';
import type { SnapshotsRepo } from './types.ts';

const CARGO_CHUNK = 200;

const snapshotsSchema = z.array(
  z.object({
    shipId: z.string().min(1),
    update: shipStateUpdateSchema,
    cargo: cargoItemsSchema.optional(),
  }),
);

/** Batch save used by the persistence service: one transaction for a whole save point. */
export function snapshotsRepo(ctx: RepoContext): SnapshotsRepo {
  const { ships, cargoItems } = ctx.t;

  return {
    async saveShipSnapshots(snapshots) {
      const parsed = snapshotsSchema.parse(snapshots);
      return ctx.transaction(async (tx) => {
        const saved: string[] = [];
        const missing: string[] = [];
        const holds = new Map<string, readonly { resourceType: string; quantity: number }[]>();
        for (const { shipId, update, cargo } of parsed) {
          const { livery, ...rest } = update;
          const rows = await tx.run((db) =>
            db
              .update(ships)
              .set({ ...rest, ...(livery ? { livery } : {}), updatedAt: tx.now() })
              .where(eq(ships.id, shipId))
              .returning({ id: ships.id }),
          );
          if (!rows[0]) {
            missing.push(shipId);
            continue;
          }
          if (cargo)
            holds.set(
              shipId,
              cargo.filter((item) => item.quantity > 0),
            );
          saved.push(shipId);
        }

        // Holds are replaced wholesale with one DELETE and one INSERT for the whole batch.
        if (holds.size > 0) {
          await tx.run((db) =>
            db.delete(cargoItems).where(inArray(cargoItems.shipId, [...holds.keys()])),
          );
          const rows = [...holds].flatMap(([shipId, items]) =>
            items.map((item) => ({ id: tx.newId(), shipId, ...item })),
          );
          for (let i = 0; i < rows.length; i += CARGO_CHUNK) {
            const slice = rows.slice(i, i + CARGO_CHUNK);
            await tx.run((db) => db.insert(cargoItems).values(slice));
          }
        }
        return { saved, missing };
      });
    },
  };
}
