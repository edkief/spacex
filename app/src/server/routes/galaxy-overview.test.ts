import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerGalaxyRoutes, clearOverviewCache } from '@server/routes/galaxy';
import type { SessionService } from '@server/auth/session';
import type { GalaxyRouter } from '@server/galaxy/router';
import { galaxyChart, systemIdForStar } from '@shared/galaxy/chart';
import { generateStars } from '@shared/galaxy/stars';

const SEED = 'DRIFT-SEED-0001';
const HOME_A = systemIdForStar(SEED, generateStars(SEED)[1].id);
const HOME_B = systemIdForStar(SEED, generateStars(SEED)[5].id);

/** Fake deps: a single good token, empty router. */
function makeDeps(): { sessions: SessionService; router: GalaxyRouter } {
  const sessions = {
    verify: async (token: string) =>
      token === 'good-token'
        ? { ok: true, player: { homeSystemId: HOME_A } }
        : { ok: false, reason: 'expired' },
  } as unknown as SessionService;
  const router = { stats: () => [] } as unknown as GalaxyRouter;
  return { sessions, router };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerGalaxyRoutes(app, { ...makeDeps(), galaxySeed: SEED });
  await app.ready();
  return app;
}

const auth = { authorization: 'Bearer good-token' };

describe('GET /api/galaxy/overview (TASK-7)', () => {
  it('rejects unauthenticated requests with the structured 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/galaxy/overview' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
    await app.close();
  });

  it('returns the seeded 3-system chart for the player home (no ?home=)', async () => {
    clearOverviewCache();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/galaxy/overview', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { seed: string; systems: unknown[] };
    expect(body.seed).toBe(SEED);
    expect(body.systems).toEqual(galaxyChart(SEED, HOME_A));
    await app.close();
  });

  it('honors ?home= and is cached in-process (same payload, no divergence)', async () => {
    clearOverviewCache();
    const app = await buildApp();
    const url = `/api/galaxy/overview?home=${HOME_B}`;
    const first = await app.inject({ method: 'GET', url, headers: auth });
    const second = await app.inject({ method: 'GET', url, headers: auth });
    expect(first.statusCode).toBe(200);
    expect(first.json().systems.map((s: { systemId: string }) => s.systemId)).toContain(HOME_B);
    expect(second.json()).toEqual(first.json());
    await app.close();
  });

  it('falls back to the player home for a malformed ?home=', async () => {
    clearOverviewCache();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/galaxy/overview?home=not-a-hex-id',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().systems).toEqual(galaxyChart(SEED, HOME_A));
    await app.close();
  });
});
