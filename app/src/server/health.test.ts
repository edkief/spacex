import { describe, expect, it } from 'vitest';
import { buildServer } from '@server/server';
import type { Env } from '@server/env';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'test-secret',
  GALAXY_SEED: 'DRIFT-SEED-0001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30000,
};

describe('server health endpoint', () => {
  it('answers GET /api/health with 200 and the galaxy seed', async () => {
    const app = buildServer(env);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, galaxySeed: 'DRIFT-SEED-0001' });
    await app.close();
  });
});
