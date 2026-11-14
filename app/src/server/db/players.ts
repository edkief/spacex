import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_CREDITS, assertPositiveInt } from './amounts.ts';
import type { RepoContext } from './context.ts';
import {
  CallsignTakenError,
  InsufficientCreditsError,
  InvalidAmountError,
  NotFoundError,
  isUniqueViolation,
} from './errors.ts';
import type { Player, PlayersRepo } from './types.ts';

const STARTING_CREDITS = 500;

const createSchema = z.strictObject({
  callsign: z.string().min(1).max(64),
  homeSystemId: z.string().min(1),
  credits: z.number().int().min(0).max(MAX_CREDITS).optional(),
});

/** Player aggregate: accounts and the credit balance. */
export function playersRepo(ctx: RepoContext): PlayersRepo {
  const { players } = ctx.t;

  /** Re-reads a balance after a conditional update matched nothing, to pick the right error. */
  async function explainMiss(
    playerId: string,
    requested: number,
    kind: 'add' | 'withdraw',
  ): Promise<never> {
    const player = await getPlayer(playerId);
    if (!player) throw new NotFoundError('player', playerId);
    if (kind === 'withdraw') throw new InsufficientCreditsError(requested, player.credits);
    throw new InvalidAmountError(`balance would exceed ${MAX_CREDITS}`);
  }

  async function getPlayer(id: string): Promise<Player | undefined> {
    const rows = await ctx.run((db) =>
      db.select().from(players).where(eq(players.id, id)).limit(1),
    );
    return rows[0];
  }

  return {
    getPlayer,

    async createPlayer(input) {
      const parsed = createSchema.parse(input);
      const row = {
        id: ctx.newId(),
        callsign: parsed.callsign,
        credits: parsed.credits ?? STARTING_CREDITS,
        homeSystemId: parsed.homeSystemId,
        createdAt: ctx.now(),
      };
      try {
        const rows = await ctx.run((db) => db.insert(players).values(row).returning());
        return rows[0] as Player;
      } catch (error) {
        if (isUniqueViolation(error, 'callsign')) throw new CallsignTakenError(parsed.callsign);
        throw error;
      }
    },

    async findPlayerByCallsign(callsign) {
      const rows = await ctx.run((db) =>
        db.select().from(players).where(eq(players.callsign, callsign)).limit(1),
      );
      return rows[0];
    },

    async addCredits(playerId, amount) {
      assertPositiveInt(amount, 'amount');
      const rows = await ctx.run((db) =>
        db
          .update(players)
          .set({ credits: sql`${players.credits} + ${amount}` })
          .where(and(eq(players.id, playerId), lte(players.credits, MAX_CREDITS - amount)))
          .returning({ credits: players.credits }),
      );
      return rows[0] ? rows[0].credits : explainMiss(playerId, amount, 'add');
    },

    async withdrawCredits(playerId, amount) {
      assertPositiveInt(amount, 'amount');
      const rows = await ctx.run((db) =>
        db
          .update(players)
          .set({ credits: sql`${players.credits} - ${amount}` })
          .where(and(eq(players.id, playerId), gte(players.credits, amount)))
          .returning({ credits: players.credits }),
      );
      return rows[0] ? rows[0].credits : explainMiss(playerId, amount, 'withdraw');
    },
  };
}
