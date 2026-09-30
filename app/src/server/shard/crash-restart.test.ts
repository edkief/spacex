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
 * TASK-24 crash-restart integration test (step 3). Boots the REAL server
 * (src/server/index.ts) as a child process on a random port with a temp DB
 * file, claims a callsign, joins the shard, flies for ~2 s, SIGKILLs the
 * process, boots it AGAIN on the same DB, rejoins, and asserts the ship
 * resumed from its last persisted state — not the spawn/dock point.
 */

const SEED = 'drift-crash-restart-seed-001';
const FLUSH_INTERVAL_MS = 300; // shorten the 30 s cadence so a 2 s flight gets flushed

const firstStar = generateStars(SEED)[0];
const SHARD_SYSTEM_ID = generateSystem(SEED, firstStar.id).systemId;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const speed = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

function bootTestServer(base: number, dbPath: string): Child {
  return bootServer({ base, dbPath, galaxySeed: SEED, flushIntervalMs: FLUSH_INTERVAL_MS });
}

let dir: string;
let child1: Child | null = null;
let child2: Child | null = null;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-crash-restart-'));
});

afterAll(() => {
  for (const c of [child1, child2]) {
    if (c && c.child.exitCode === null) c.child.kill('SIGKILL');
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('crash-restart (integration, step 3)', () => {
  it('SIGKILL mid-flight: the restarted server resumes the ship from its saved state', async () => {
    const dbPath = path.join(dir, 'crash.db');

    // ── boot 1 ─────────────────────────────────────────────────────────────
    const port1 = await freePort();
    child1 = bootTestServer(port1, dbPath);
    await waitReady(child1);

    const claimRes = await fetch(`http://127.0.0.1:${port1}/api/callsigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign: `crash-${Date.now().toString(36)}` }),
    });
    expect(claimRes.status).toBe(201);
    const claim = (await claimRes.json()) as {
      token: string;
      playerId: string;
      shipId: string;
    };

    const ws1 = new WsChildClient(port1, claim.token, SHARD_SYSTEM_ID);
    await ws1.next((m) => m.type === 'enter_system', 'enter_system');
    const dock = await ws1.next(
      (m) =>
        m.type === 'entity_update' && m.payload.entities.some((e: any) => e.id === claim.shipId),
      'first snapshot with the player ship',
    );
    const p0: Vec3 = dock.payload.entities.find((e: any) => e.id === claim.shipId).pos;

    // Fly: ~2 s of full thrust (40 inputs at 50 ms, one per sim tick).
    for (let seq = 1; seq <= 40; seq++) {
      ws1.send({
        v: 1,
        type: 'input',
        payload: { seq, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      });
      await new Promise((r) => setTimeout(r, 50));
    }
    // Coast and let at least one 300 ms flush land, then take stock.
    await new Promise((r) => setTimeout(r, 700));
    const last = ws1.latestEntity(claim.shipId);
    expect(last, 'snapshots carried the flying ship').toBeDefined();
    const speedAtKill = speed(last.vel);
    expect(speedAtKill).toBeGreaterThan(10); // the sim actually integrated inputs
    ws1.close();

    // ── hard crash ─────────────────────────────────────────────────────────
    child1.child.kill('SIGKILL');
    const { signal } = await new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
      child1!.child.once('exit', (_c, s) => resolve({ signal: s }));
    });
    expect(signal).toBe('SIGKILL');

    // Read the last persisted state straight from the (WAL) db file.
    const handle = createDb({ driver: 'sqlite', dbPath });
    const repo = createRepo(handle.db, sqliteTables);
    const row = await repo.getShipByOwner(claim.playerId);
    expect(row, 'the ship row survived the crash').toBeDefined();
    expect(row!.state).toBe('flying');
    const pDb: Vec3 = row!.position;

    // The flush kept the persisted state current (≤ 1 flush period + snapshot lag).
    expect(dist(pDb, last.pos)).toBeLessThanOrEqual(speedAtKill * (0.55 + 0.05) + 1);
    // And the ship really flew away from the dock (no trivial test: a dock
    // position would trivially "survive" a crash).
    const fledFromDock = dist(pDb, p0);
    expect(fledFromDock).toBeGreaterThan(40);

    // ── boot 2 (same db, fresh process) ────────────────────────────────────
    const port2 = await freePort();
    child2 = bootTestServer(port2, dbPath);
    await waitReady(child2);
    const tBoot2 = Date.now();

    const ws2 = new WsChildClient(port2, claim.token, SHARD_SYSTEM_ID); // same session: 7 d TTL
    await ws2.next((m) => m.type === 'enter_system', 'enter_system after restart');
    const resumed = await ws2.next(
      (m) =>
        m.type === 'entity_update' && m.payload.entities.some((e: any) => e.id === claim.shipId),
      'first snapshot after restart',
    );
    const e: any = resumed.payload.entities.find((x: any) => x.id === claim.shipId);
    ws2.close();

    // Continuity: the ship resumed from the persisted row. It coasts at the
    // saved velocity from the moment the sim ticks, so the new position is
    // the row position plus exactly the measured boot-to-snapshot window —
    // NOT the dock/spawn point. (1 u + one tick of movement slack.)
    const elapsedS = (Date.now() - tBoot2) / 1000;
    const drift = speedAtKill * elapsedS;
    const delta = dist(e.pos, pDb);
    expect(delta).toBeLessThanOrEqual(drift + speedAtKill * 0.3 + 1);
    // No teleport: still far out where it crashed, not back at the dock.
    expect(dist(e.pos, p0)).toBeGreaterThan(0.5 * fledFromDock);
    // The sim resumed with the PERSISTED velocity exactly (space coasting is
    // drag-free: a loaded ship coasts at its saved velocity, held input
    // cleared). last.vel may be up to one flush period newer than the row.
    expect(dist(e.vel, row!.velocity)).toBeLessThan(0.01);
    expect(e.hull).toBeGreaterThan(0.99); // no damage happened; hull persisted at full
    expect(e.regime).toBe('sublight');
  }, 60000);
});
