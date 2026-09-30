import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { bootServer, freePort, waitReady, WsChildClient, type Child } from '@server/server-child';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';

/**
 * TASK-12 graceful-shutdown integration test: boots the REAL server
 * (src/server/index.ts) as a child process, claims + joins a player,
 * flies for a moment, then sends SIGTERM — the server must flush every
 * active shard, exit with code 0 (NOT the watchdog's code 1), and the DB
 * must contain the ship's final state.
 */

const SEED = 'drift-shutdown-seed-001';
const FLUSH_INTERVAL_MS = 300;

const firstStar = generateStars(SEED)[0];
const SHARD_SYSTEM_ID = generateSystem(SEED, firstStar.id).systemId;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

let dir: string;
let child: Child | null = null;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-shutdown-'));
});

afterAll(() => {
  if (child && child.child.exitCode === null) child.child.kill('SIGKILL');
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('graceful shutdown (TASK-12)', () => {
  it('SIGTERM flushes all active shards, exits 0, and the DB keeps the ship state', async () => {
    const dbPath = path.join(dir, 'shutdown.db');
    const base = await freePort();
    child = bootServer({ base, dbPath, galaxySeed: SEED, flushIntervalMs: FLUSH_INTERVAL_MS });
    await waitReady(child);

    const claimRes = await fetch(`http://127.0.0.1:${base}/api/callsigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign: `sigterm-${Date.now().toString(36)}` }),
    });
    expect(claimRes.status).toBe(201);
    const claim = (await claimRes.json()) as { token: string; playerId: string; shipId: string };

    const ws = new WsChildClient(base, claim.token, SHARD_SYSTEM_ID);
    await ws.next((m) => m.type === 'enter_system', 'enter_system');
    await ws.next(
      (m) =>
        m.type === 'entity_update' && m.payload.entities.some((e: any) => e.id === claim.shipId),
      'first snapshot with the player ship',
    );

    // Fly briefly (20 inputs at 50 ms), then coast so a flush period lands.
    for (let seq = 1; seq <= 20; seq++) {
      ws.send({
        v: 1,
        type: 'input',
        payload: { seq, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 700));
    const last = ws.latestEntity(claim.shipId);
    expect(last, 'snapshots carried the flying ship').toBeDefined();
    expect(last.vel).toBeDefined();

    // ── graceful stop ──────────────────────────────────────────────────────
    const t0 = Date.now();
    child.child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child!.child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    const elapsedMs = Date.now() - t0;

    // Exit code 0 (a wedged shutdown would hit the 10 s watchdog → exit 1);
    // the flush + close well inside the watchdog.
    expect(exit.code, `server output:\n${child.tail()}`).toBe(0);
    expect(exit.signal).toBeNull();
    expect(elapsedMs).toBeLessThan(10_000);
    ws.close();

    // The DB contains the ship's final state (flushed before exit).
    const handle = createDb({ driver: 'sqlite', dbPath });
    const repo = createRepo(handle.db, sqliteTables);
    const row = await repo.getShipByOwner(claim.playerId);
    expect(row, 'the ship row survived the shutdown').toBeDefined();
    expect(row!.state).toBe('flying');
    // The persisted position is close to where the ship was seen in flight
    // (≤ one flush period + snapshot lag of coasting).
    const speed = Math.hypot(last.vel.x, last.vel.y, last.vel.z);
    expect(dist(row!.position, last.pos)).toBeLessThanOrEqual(speed * (0.55 + 0.05) + 1);
    (handle.raw as { close?: () => void }).close?.();
  }, 60000);
});
