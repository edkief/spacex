import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer, type DriftServer } from './app.ts';
import { denyAllAuthenticator } from './auth/types.ts';
import { loadConfig } from './config.ts';
import { createGalaxyDirectory } from './directory.ts';
import { REST_BODY_LIMIT, parseOr400 } from './rest.ts';

const config = loadConfig({ SESSION_SECRET: 'x'.repeat(40), NODE_ENV: 'test' });
const apps: DriftServer[] = [];

/** A server with a few throwaway routes exercising the shared REST validation helpers. */
function testApp(): DriftServer {
  const app = buildServer({
    config,
    authenticator: denyAllAuthenticator,
    directory: createGalaxyDirectory({ seed: 'rest-test' }),
  });
  apps.push(app);
  const body = z.strictObject({ name: z.string().min(1).max(8), count: z.number().int().min(0) });
  app.post('/api/_echo', (request, reply) => {
    const parsed = parseOr400(body, request.body, request, reply);
    return parsed ? { ok: true, name: parsed.name } : undefined;
  });
  app.get('/api/_boom', () => {
    throw new Error('secret internal detail');
  });
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('REST validation and error shape', () => {
  const post = (
    app: DriftServer,
    payload: string,
    headers = { 'content-type': 'application/json' },
  ) => app.inject({ method: 'POST', url: '/api/_echo', payload, headers });

  it('accepts a valid body', async () => {
    const response = await post(testApp(), JSON.stringify({ name: 'abc', count: 1 }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, name: 'abc' });
  });

  it.each([
    ['wrong types', { name: 5, count: 'x' }],
    ['unknown field', { name: 'abc', count: 1, admin: true }],
    ['missing field', { name: 'abc' }],
    ['too long', { name: 'abcdefghi', count: 1 }],
    ['negative count', { name: 'abc', count: -1 }],
    ['fraction', { name: 'abc', count: 1.5 }],
    ['null', null],
    ['array', []],
  ])('answers 400 {code, message} for %s without echoing input', async (_label, body) => {
    const response = await post(testApp(), JSON.stringify(body));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'invalid-request', message: 'invalid request' });
  });

  it('maps malformed JSON, empty bodies, wrong media types and oversize bodies', async () => {
    const app = testApp();
    for (const [payload, headers, status] of [
      ['{nope', { 'content-type': 'application/json' }, 400],
      ['', { 'content-type': 'application/json' }, 400],
      ['<x/>', { 'content-type': 'application/xml' }, 415],
      ['name=x', { 'content-type': 'text/plain' }, 400],
      [
        JSON.stringify({ name: 'a'.repeat(REST_BODY_LIMIT + 10), count: 1 }),
        { 'content-type': 'application/json' },
        413,
      ],
    ] as const) {
      const response = await post(app, payload, headers);
      expect(response.statusCode).toBe(status);
      const body = response.json<Record<string, string>>();
      expect(Object.keys(body).sort()).toEqual(['code', 'message']);
      expect(body['code']).toBe('invalid-request');
    }
  });

  it('answers unknown API routes with 404 not-found and hides internal errors', async () => {
    const app = testApp();
    const missing = await app.inject('/api/does-not-exist');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'not-found', message: 'not found' });
    const boom = await app.inject('/api/_boom');
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ code: 'internal', message: 'internal error' });
    expect(boom.body).not.toContain('secret internal detail');
  });
});
