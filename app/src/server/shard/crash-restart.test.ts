import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';

/**
 * TASK-24 crash-restart integration test (step 3). Boots the REAL server
 * (src/server/index.ts) as a child process on a random port with a temp DB
 * file, claims a callsign, joins the shard, flies for ~2 s, SIGKILLs the
 * process, boots it AGAIN on the same DB, rejoins, and asserts the ship
 * resumed from its last persisted state — not the spawn/dock point.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

interface Child {
  child: ChildProcess;
  base: number;
  /** Recent server output, attached to assertion errors for debugging. */
  tail(): string;
}

function bootServer(base: number, dbPath: string): Child {
  const env = {
    ...process.env,
    PORT: String(base),
    SESSION_SECRET: 'crash-restart-test-secret', // same for BOTH boots: the token must survive the restart
    GALAXY_SEED: SEED,
    DB_DRIVER: 'sqlite',
    DB_PATH: dbPath,
    DATABASE_URL: '',
    SYSTEM_INSTANCE_COUNT: '1',
    SHARD_FLUSH_INTERVAL_MS: String(FLUSH_INTERVAL_MS),
  };
  // Invoke tsx's loader flags directly (same command line the tsx CLI
  // builds) so the spawned PID is the script's own node process — any
  // intermediate wrapper would make child.kill() orphan the real process.
  const tsxDist = path.join(appDir, 'node_modules', 'tsx', 'dist');
  const child = spawn(
    process.execPath,
    [
      '--require',
      path.join(tsxDist, 'preflight.cjs'),
      '--import',
      pathToFileURL(path.join(tsxDist, 'loader.mjs')).href,
      path.join(appDir, 'src', 'server', 'index.ts'),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));
  return {
    child,
    base,
    tail: () => out.slice(-4000),
  };
}

/** Poll /api/health until the server answers 200 (real boot, real listen). */
async function waitReady(c: Child, timeoutMs = 45000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (c.child.exitCode !== null) {
      throw new Error(`server exited with code ${c.child.exitCode}:\n${c.tail()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${c.base}/api/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`server did not become ready in ${timeoutMs} ms:\n${c.tail()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Minimal WS protocol client (hello → auth → join_system, message queue). */
class WsClient {
  private ws: WebSocket;
  private queue: any[] = [];
  private waiters: Array<{
    predicate: (m: any) => boolean;
    resolve: (m: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  closed = false;

  constructor(base: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${base}/ws`);
    this.ws.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      this.queue.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.predicate(m)) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(m);
        }
      }
    });
    this.ws.on('close', () => (this.closed = true));
    this.ws.on('open', () => {
      this.send({ v: 1, type: 'hello', payload: { v: 1 } });
      this.send({ v: 1, type: 'auth', payload: { token } });
      this.send({ v: 1, type: 'join_system', payload: { systemId: SHARD_SYSTEM_ID } });
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next(predicate: (m: any) => boolean, what: string, timeoutMs = 8000): Promise<any> {
    const found = this.queue.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${what}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate: (m) => {
          if (!predicate(m)) return false;
          // drop it from the queue so later next() calls don't reuse it
          const i = this.queue.indexOf(m);
          if (i >= 0) this.queue.splice(i, 1);
          return true;
        },
        resolve,
        reject,
        timer,
      });
    });
  }

  /** The latest entity_update payload's entity for id (recomputed each call). */
  latestEntity(id: string): any | undefined {
    let out: any;
    for (const m of this.queue) {
      if (m.type !== 'entity_update') continue;
      const e = m.payload.entities.find((x: any) => x.id === id);
      if (e) out = { ...e, at: Date.now() };
    }
    return out;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
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
    child1 = bootServer(port1, dbPath);
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

    const ws1 = new WsClient(port1, claim.token);
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
    child2 = bootServer(port2, dbPath);
    await waitReady(child2);
    const tBoot2 = Date.now();

    const ws2 = new WsClient(port2, claim.token); // same session: 7 d TTL
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
