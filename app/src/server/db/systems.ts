import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RepoContext } from './context.ts';
import { NotFoundError } from './errors.ts';
import type { SystemRegistryRepo } from './types.ts';

const upsertSchema = z.strictObject({ systemId: z.string().min(1), name: z.string().min(1) });

/** System-registry aggregate: which systems exist and whether their shard is running. */
export function systemsRepo(ctx: RepoContext): SystemRegistryRepo {
  const { systemRegistry } = ctx.t;

  async function getSystem(systemId: string) {
    const rows = await ctx.run((db) =>
      db.select().from(systemRegistry).where(eq(systemRegistry.systemId, systemId)).limit(1),
    );
    return rows[0];
  }

  return {
    getSystem,

    async upsertSystem(input) {
      const parsed = upsertSchema.parse(input);
      const rows = await ctx.run((db) =>
        db
          .insert(systemRegistry)
          .values({ ...parsed, shardActive: false, lastActiveAt: null })
          .onConflictDoUpdate({ target: systemRegistry.systemId, set: { name: parsed.name } })
          .returning(),
      );
      return rows[0]!;
    },

    async setShardActive(systemId, active) {
      const rows = await ctx.run((db) =>
        db
          .update(systemRegistry)
          .set({ shardActive: active, lastActiveAt: ctx.now() })
          .where(eq(systemRegistry.systemId, systemId))
          .returning(),
      );
      if (!rows[0]) throw new NotFoundError('system', systemId);
      return rows[0];
    },
  };
}
