import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { createShipSwapBus } from '@server/shards';
import { createGalaxyRouter } from '@server/galaxy/router';
import { messageSchemas } from '@shared/protocol/schemas';
import { RESOURCE_IDS } from '@shared/inventory';
import { callsignSchema } from '@shared/callsign';
import { CHAT_MAX_CHARS, CHAT_WINDOW_MAX, CHAT_WINDOW_MS } from '@shared/chat';
import { MINING_UNIT_MS } from '@shared/mining';
import { FIRE_SPAM_LIMIT, WEAPON_LOCK_MS } from '@server/shard/shard';
import { MESSAGE_BURST, MESSAGE_RATE } from '@server/ratelimit';
import { LIMITER_KINDS, LIMITER_REGISTRY, STATEFUL_HANDLERS } from '@server/limiter-registry';

/**
 * TASK-67 step 4: the audit tests.
 *
 * 1. SCHEMA COVERAGE (TASK-64): every WS entry point the server accepts has
 *    a zod schema in the shared registry, and the registry has no orphans —
 *    no undocumented entry point on either side.
 * 2. REST COVERAGE: every registered body-accepting route is in the manifest
 *    with a real schema (two-way equality: a new route without a schema, or
 *    a stale manifest entry, fails the test).
 * 3. RATE-LIMIT COVERAGE (TASK-65): the limiter registry covers every
 *    stateful handler, and the bounds it cites are the implementation's real
 *    constants (pinned to their values here).
 */

// ---------------------------------------------------------------------------
// 1. WS schema coverage
// ---------------------------------------------------------------------------

/** The handshake / connection types handled in ws.ts handleMessage. */
const HANDSHAKE = ['hello', 'auth', 'join_system', 'warp', 'logout'] as const;
/** Mirror of ws.ts SYSTEM_SCOPED (types that require an active system). */
const SYSTEM_SCOPED = [
  'input',
  'interact',
  'mine',
  'sell',
  'buy_ship',
  'set_livery',
  'exit_ship',
  'enter_ship',
  'repair',
  'chat',
  'target_update',
  'target_lock',
  'target_release',
] as const;
/** Mirror of shards.ts routeGameMessage dispatch (inbound gameplay). */
const GAME_DISPATCH = [
  'input',
  'chat',
  'exit_ship',
  'interact',
  'drop',
  'enter_ship',
  'cargo_open',
  'cargo_transfer',
  'fire',
  'sell',
  'target_lock',
  'target_release',
] as const;
/** Connection-level types handled before dispatch. */
const MISC = ['ping', 'pong', 'error'] as const;
/** Server → client only (never dispatched from an inbound frame). */
const OUTBOUND_ONLY = [
  'enter_system',
  'state_snapshot',
  'entity_update',
  'mining',
  'cargo',
  'ui-open',
  'ack',
  'warp_arrived',
  'combat_event',
  'presence',
  'hazard',
] as const;

const INBOUND = [...HANDSHAKE, ...SYSTEM_SCOPED, ...GAME_DISPATCH, ...MISC];
const SCHEMA_KEYS = Object.keys(messageSchemas);

describe('audit: WS schema coverage (TASK-64)', () => {
  it('every inbound entry point has a zod schema', () => {
    const missing = INBOUND.filter((t) => !(t in messageSchemas));
    expect(missing, `inbound types without a schema: ${missing}`).toEqual([]);
  });

  it('the registry has no orphans: inbound ∪ server-only == the registry', () => {
    const union: Set<string> = new Set([...INBOUND, ...OUTBOUND_ONLY]);
    const registry = new Set<string>(SCHEMA_KEYS);
    const missingFromUnion = [...registry].filter((k) => !union.has(k));
    const undocumented = [...union].filter((k) => !registry.has(k));
    expect(missingFromUnion, 'registry types that are neither inbound nor server-only').toEqual([]);
    expect(undocumented, 'entry points with no schema entry').toEqual([]);
  });

  it('every schema is a live zod schema that rejects undefined payloads', () => {
    for (const key of SCHEMA_KEYS) {
      const schema = (messageSchemas as Record<string, z.ZodType>)[key];
      expect(typeof schema.safeParse, key).toBe('function');
      expect(schema.safeParse(undefined).success, `${key} must reject undefined`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. REST schema coverage — the manifest: every body-accepting route
// ---------------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

interface ManifestEntry {
  schema: z.ZodType;
  valid: unknown;
  invalid: unknown;
}

/**
 * The documented REST body contracts. Two-way checked against the routes
 * actually registered by registerApiRoutes: an unlisted body route is an
 * undocumented entry point; a listed-but-unregistered path is stale.
 */
const REST_MANIFEST: Record<string, ManifestEntry> = {
  '/api/callsigns': {
    schema: z.object({ callsign: callsignSchema }).strict(),
    valid: { callsign: 'audit-test' },
    invalid: { callsign: 'x' }, // 3-char minimum
  },
  '/api/ships/buy': {
    schema: z.object({ classId: z.string().min(1).max(32) }).strict(),
    valid: { classId: 'scout' },
    invalid: { classId: '' },
  },
  '/api/ships/livery': {
    schema: z
      .object({
        colors: z.object({ hull: hex, accent: hex, trim: hex }).strict(),
      })
      .strict(),
    valid: { colors: { hull: '#123456', accent: '#654321', trim: '#abcdef' } },
    invalid: { colors: { hull: 'red', accent: '#654321', trim: '#abcdef' } },
  },
  '/api/ships/sell': {
    schema: z
      .object({
        resourceId: z.string().min(1).max(32),
        amount: z.number().int().finite().positive(),
        source: z.enum(['hold', 'inv']),
      })
      .strict(),
    valid: { resourceId: 'iron', amount: 5, source: 'hold' },
    invalid: { resourceId: 'iron', amount: 5, source: 'vault' },
  },
  '/api/dev/teleport': {
    schema: z
      .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
      .strict(),
    valid: { x: 1, y: 2, z: 3 },
    invalid: { x: 1, y: 2 },
  },
  '/api/dev/teleport-char': {
    schema: z
      .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
      .strict(),
    valid: { x: 1, y: 2, z: 3 },
    invalid: { x: '1', y: 2, z: 3 },
  },
  '/api/dev/deposit': {
    schema: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
        quantity: z.number().int().finite().positive().max(1000).optional(),
        resourceId: z.enum(RESOURCE_IDS).optional(),
      })
      .strict(),
    valid: { x: 1, y: 2, z: 3, quantity: 5, resourceId: 'iron' },
    invalid: { x: 1, y: 2, z: 3, quantity: -5 },
  },
  '/api/dev/give': {
    schema: z
      .object({
        resourceId: z.enum(RESOURCE_IDS),
        amount: z.number().int().finite().positive().max(10_000),
      })
      .strict(),
    valid: { resourceId: 'iron', amount: 10 },
    invalid: { resourceId: 'iron', amount: 0 },
  },
  '/api/dev/dummy-target': {
    schema: z.object({ distance: z.number().finite().positive().max(450).optional() }).strict(),
    valid: { distance: 200 },
    invalid: { distance: 0 },
  },
  '/api/dev/combat-kill': {
    schema: z
      .object({
        victim: z.string().min(1).max(64),
        weapon: z.enum(['laser', 'missile']).optional(),
      })
      .strict(),
    valid: { victim: 'ai:dummy:1', weapon: 'laser' },
    invalid: { victim: '' },
  },
};
// NOTE: POST /api/session/logout takes NO body (token in the auth header),
// so it has no body schema to audit. /api/ships/repair is likewise body-less
// (the repair scope is derived server-side from the ship state).

const env: Env = {
  PORT: 3004,
  SESSION_SECRET: 'audit-secret',
  GALAXY_SEED: 'DRIFT-SEED-0001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30_000,
};

describe('audit: REST schema coverage (every body route is in the manifest)', () => {
  let dir: string;
  let closeApp: () => Promise<void>;
  let bodyRoutes: string[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-audit-'));
    const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'audit.db') });
    const repo: Repository = createRepo(db, sqliteTables);
    const sessions = createSessionService({ repo, codec: createTokenCodec('audit-secret') });
    const router = createGalaxyRouter({
      repo,
      galaxySeed: env.GALAXY_SEED,
      shipSwapBus: createShipSwapBus(),
    });
    const app = buildServer(env);
    // Fastify has no routes() lookup: capture every registered route via
    // the onRoute hook installed BEFORE registerApiRoutes.
    const captured: Array<{ method: string; url: string }> = [];
    app.addHook('onRoute', (r) => {
      const methods: string[] = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) captured.push({ method: m, url: r.url });
    });
    registerApiRoutes(app, {
      repo,
      sessions,
      galaxySeed: env.GALAXY_SEED,
      shipSwapBus: createShipSwapBus(),
      galaxyRouter: router,
    });
    closeApp = async () => {
      await app.close();
    };
    // No listen needed: the route table is complete at registration time.
    await app.ready();
    const BODYLESS_POSTS = new Set(['/api/session/logout', '/api/ships/repair']);
    bodyRoutes = captured
      .filter((r) => r.method === 'POST' && r.url.startsWith('/api/'))
      .map((r) => r.url)
      .filter((url) => !BODYLESS_POSTS.has(url));
  });

  afterAll(async () => {
    await closeApp();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every registered body route has a manifest entry (no undocumented entry points)', () => {
    const undocumented = bodyRoutes.filter((url) => !(url in REST_MANIFEST));
    expect(
      undocumented,
      `registered body routes missing from the manifest: ${undocumented}`,
    ).toEqual([]);
  });

  it('the manifest has no stale entries (every listed route is registered)', () => {
    const stale = Object.keys(REST_MANIFEST).filter((url) => !bodyRoutes.includes(url));
    expect(stale, `manifest entries with no registered route: ${stale}`).toEqual([]);
  });

  it.each(Object.entries(REST_MANIFEST))(
    '%s: schema accepts the valid body and rejects a bad one',
    (url, { schema, valid, invalid }) => {
      expect(schema.safeParse(valid).success, `${url} valid body`).toBe(true);
      expect(schema.safeParse(invalid).success, `${url} invalid body`).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Rate-limit coverage (TASK-65): the registry covers the handler list
// ---------------------------------------------------------------------------

describe('audit: rate-limit coverage (every stateful handler has an explicit limiter)', () => {
  it('the registry covers exactly the required stateful handler list', () => {
    expect([...STATEFUL_HANDLERS].sort()).toEqual([
      'chat',
      'fire',
      'interact',
      'join',
      'mine',
      'sell',
      'warp',
    ]);
    for (const handler of STATEFUL_HANDLERS) {
      const entry = LIMITER_REGISTRY[handler];
      expect(entry, `registry entry for ${handler}`).toBeDefined();
      expect(entry.handler).toBe(handler);
      expect(
        (LIMITER_KINDS as readonly string[]).includes(entry.kind),
        `${handler}: unknown limiter kind ${entry.kind}`,
      ).toBe(true);
      expect(entry.bound.length, `${handler}: bound must be documented`).toBeGreaterThan(0);
    }
  });

  it('the cited bounds are the implementation constants, pinned', () => {
    // Pinned to the shipped values (TASK-16/65, TASK-38, TASK-43): a silent
    // change of any bound breaks this audit before it reaches CI traffic.
    expect(MESSAGE_RATE).toBe(20);
    expect(MESSAGE_BURST).toBe(40);
    expect(CHAT_MAX_CHARS).toBe(200);
    expect(CHAT_WINDOW_MAX).toBe(5);
    expect(CHAT_WINDOW_MS).toBe(10_000);
    expect(MINING_UNIT_MS).toBe(1_500);
    expect(FIRE_SPAM_LIMIT).toBe(30);
    expect(WEAPON_LOCK_MS).toBe(5_000);
  });
});
