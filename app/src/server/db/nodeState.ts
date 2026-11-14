import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RepoContext } from './context.ts';
import type { NodeStateRepo } from './types.ts';

const CHUNK = 200;

const stateSchema = z.strictObject({
  nodeId: z.string().min(1),
  systemId: z.string().min(1),
  quantityRemaining: z.number().int().min(0).max(2_147_483_647),
  respawnAt: z.date().nullable(),
});

/** Resource-node aggregate: only depleted/respawning nodes are persisted, never geometry. */
export function nodeStateRepo(ctx: RepoContext): NodeStateRepo {
  const { resourceNodeState } = ctx.t;

  async function upsertNodeStates(states: readonly unknown[]): Promise<void> {
    const parsed = z.array(stateSchema).parse(states);
    // Last write wins per node id within one batch (a single statement may not hit a key twice).
    const unique = [...new Map(parsed.map((state) => [state.nodeId, state])).values()];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      await ctx.run((db) =>
        db
          .insert(resourceNodeState)
          .values(slice)
          .onConflictDoUpdate({
            target: resourceNodeState.nodeId,
            set: {
              systemId: sql`excluded.system_id`,
              quantityRemaining: sql`excluded.quantity_remaining`,
              respawnAt: sql`excluded.respawn_at`,
            },
          }),
      );
    }
  }

  return {
    upsertNodeStates,
    upsertNodeState: (state) => upsertNodeStates([state]),

    async listNodeStates(systemId) {
      return ctx.run((db) =>
        db
          .select()
          .from(resourceNodeState)
          .where(eq(resourceNodeState.systemId, systemId))
          .orderBy(asc(resourceNodeState.nodeId)),
      );
    },
  };
}
