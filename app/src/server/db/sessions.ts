import { eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { RepoContext } from './context.ts';
import { NotFoundError } from './errors.ts';
import type { SessionsRepo } from './types.ts';

const createSchema = z.object({
  tokenHash: z.string().min(1),
  playerId: z.string().min(1),
  systemId: z.string().min(1).nullable().optional(),
  expiresAt: z.date(),
});

/** Session aggregate: hashed bearer tokens with expiry (hashing itself belongs to auth). */
export function sessionsRepo(ctx: RepoContext): SessionsRepo {
  const { sessions } = ctx.t;

  return {
    async createSession(input) {
      const parsed = createSchema.parse(input);
      const rows = await ctx.run((db) =>
        db
          .insert(sessions)
          .values({
            tokenHash: parsed.tokenHash,
            playerId: parsed.playerId,
            systemId: parsed.systemId ?? null,
            createdAt: ctx.now(),
            expiresAt: parsed.expiresAt,
          })
          .returning(),
      );
      return rows[0]!;
    },

    async getSession(tokenHash) {
      const rows = await ctx.run((db) =>
        db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1),
      );
      return rows[0];
    },

    async setSessionSystem(tokenHash, systemId) {
      const rows = await ctx.run((db) =>
        db
          .update(sessions)
          .set({ systemId })
          .where(eq(sessions.tokenHash, tokenHash))
          .returning({ tokenHash: sessions.tokenHash }),
      );
      if (!rows[0]) throw new NotFoundError('session', '<token>');
    },

    async deleteSession(tokenHash) {
      const rows = await ctx.run((db) =>
        db
          .delete(sessions)
          .where(eq(sessions.tokenHash, tokenHash))
          .returning({ tokenHash: sessions.tokenHash }),
      );
      return rows.length > 0;
    },

    async deleteSessionsForPlayer(playerId) {
      const rows = await ctx.run((db) =>
        db
          .delete(sessions)
          .where(eq(sessions.playerId, playerId))
          .returning({ tokenHash: sessions.tokenHash }),
      );
      return rows.length;
    },

    async deleteExpiredSessions(now) {
      const rows = await ctx.run((db) =>
        db
          .delete(sessions)
          .where(lte(sessions.expiresAt, now))
          .returning({ tokenHash: sessions.tokenHash }),
      );
      return rows.length;
    },
  };
}
