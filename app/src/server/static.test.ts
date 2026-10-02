import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@server/server';
import { registerStaticClient } from '@server/static';
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

describe('static client serving (production image)', () => {
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-static-'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Drift</title>');
    fs.writeFileSync(path.join(root, 'assets', 'main-abc123.js'), 'console.log(1);');
    app = buildServer(env);
    await registerStaticClient(app, root);
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves index.html at / with no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Drift</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets as immutable', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/main-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('leaves API routes untouched and 404s unknown files', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, galaxySeed: 'DRIFT-SEED-0001' });
    const missing = await app.inject({ method: 'GET', url: '/nope.js' });
    expect(missing.statusCode).toBe(404);
  });
});
