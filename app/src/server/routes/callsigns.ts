import { FastifyInstance } from 'fastify';
import { repo } from '../db/repo';
import { CallsignClaimSchema } from '@shared/protocol/schemas';
import { signToken, hashToken } from '../auth/token';
import { seedFromString, hash2 } from '@shared/random';
import { GALAXY_SEED } from '../app';
import { GALAXY_STAR_COUNT } from '@shared/galaxy/config';
import { CallsignTakenError } from '../db/types';

export async function callsignRoutes(fastify: FastifyInstance) {
  fastify.post('/api/callsigns', async (request, reply) => {
    const result = CallsignClaimSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        code: 'invalid-message',
        message: 'Invalid callsign format. Use 3-16 alphanumeric characters and dashes.',
      });
    }

    const { callsign } = result.data;
    const normalizedCallsign = callsign.toLowerCase();

    try {
      // Derive home system from callsign seed
      const masterSeed = seedFromString(GALAXY_SEED);
      const callsignSeed = seedFromString(normalizedCallsign);
      const starIndex = Number(callsignSeed % BigInt(GALAXY_STAR_COUNT));
      const systemId = hash2(masterSeed, BigInt(starIndex)).toString(16);

      // 1. Create the player
      const player = await repo.createPlayer(normalizedCallsign, systemId);

      // 2. Get or create starter ship
      await repo.getOrCreateStarterShip(player.id, systemId);

      // 3. Issue session token
      const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const token = signToken({
        playerId: player.id,
        systemId,
        exp,
      });

      // 4. Store session hash in DB
      await repo.createSession(player.id, systemId, hashToken(token));

      return reply.send({
        callsign: normalizedCallsign,
        token,
        playerId: player.id,
        homeSystemId: systemId,
      });
    } catch (e: any) {
      if (e instanceof CallsignTakenError) {
        return reply.status(409).send({
          code: 'callsign-taken',
          message: e.message,
        });
      }
      throw e;
    }
  });
}
