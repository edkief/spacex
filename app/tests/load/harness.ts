import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { attachShipSwapBroadcast, createShipSwapBus, routeGameMessage } from '@server/shards';
import { attachWebSocket } from '@server/ws';
import { createGalaxyRouter, type GalaxyRouter } from '@server/galaxy/router';
import { createRouterGateway } from '@server/galaxy/gateway';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { padsForSystem } from '@shared/world/pads';
import { terminalsFor } from '@shared/world/terminals';
import { TICK_DT_MS } from '@server/shard';
import { LoadClient, percentile, type Role } from './client';
import { createRoleDriver, type RoleDriver, type Vec3 } from './roles';

/**
 * TASK-18: the 16-player load test — one process, 16 real WebSocket clients
 * to a real server on a random port (file DB in tmp, the shard flush hits
 * it). Mixed roles: 8 flying + firing, 4 on foot + mining (with the
 * mine→sell resource loop), 2 warping in/out on a 60 s cadence, 2 idle.
 *
 * Full run (npm run load, 5 min): every acceptance metric — snapshot rate,
 * starvation, p95 message size, input→ack RTT, tick rate/stall, heap delta,
 * kicks, the t=2 min reconnect wave (+ entity consistency) and the
 * t=1 min 17th-client cap probe.
 * Smoke run (npm run load:smoke, 30 s): snapshot rate + cap probe only.
 *
 * The report (per-client + aggregate metrics, assertions, RTT percentiles,
 * tick histogram, heap delta) is printed AND written to a tmp JSON file —
 * the recorded numbers TASK-61 consumes.
 */

const SMOKE = process.argv.includes('--smoke');
const DURATION_MS = SMOKE ? 30_000 : 300_000;
const CAP_PROBE_MS = SMOKE ? 20_000 : 60_000;
const RECONNECT_MS = 120_000;
const WARP_TIMES = [90_000, 150_000, 210_000, 270_000]; // 60 s cadence, in/out
const GALAXY_SEED = 'drift-load-seed-018';
const N_PLAYERS = 16;

interface Player {
  token: string;
  playerId: string;
  shipId: string;
  homeSystemId: string;
  callsign: string;
}

/** SYS_A = first seeded system with a landing pad (the foot role); SYS_B = another. */
function pickSystems(): {
  A: { systemId: string; pad: Vec3; terminal: Vec3 };
  B: string;
} {
  const stars = generateStars(GALAXY_SEED);
  const systems = stars.map((s) => generateSystem(GALAXY_SEED, s.id));
  let A: { systemId: string; pad: Vec3; terminal: Vec3 } | null = null;
  for (const sys of systems) {
    const pads = padsForSystem(GALAXY_SEED, sys);
    if (pads.length === 0) continue;
    A = { systemId: sys.systemId, pad: { ...pads[0].pos }, terminal: { ...terminalsFor(GALAXY_SEED, sys)[0].pos } };
    break;
  }
  if (!A) throw new Error('no pad system in the seeded galaxy');
  const B = systems.find((s) => s.systemId !== A.systemId);
  if (!B) throw new Error('galaxy has only one system');
  return { A, B: B.systemId };
}

async function bootServer(dir: string) {
  const env: Env = {
    PORT: 3000,
    SESSION_SECRET: 'load-test-secret',
    GALAXY_SEED,
    DB_DRIVER: 'sqlite',
    DB_PATH: path.join(dir, 'load.db'),
    DATABASE_URL: '',
    SYSTEM_INSTANCE_COUNT: 3,
    WS_PATH: '/ws',
    SHARD_FLUSH_INTERVAL_MS: 30_000,
  };
  const { db } = createDb({ driver: 'sqlite', dbPath: env.DB_PATH });
  const repo: Repository = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec(env.SESSION_SECRET) });
  const shipSwapBus = createShipSwapBus();
  const router: GalaxyRouter = createGalaxyRouter({ repo, galaxySeed: GALAXY_SEED, shipSwapBus });
  const app: FastifyInstance = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: GALAXY_SEED, shipSwapBus, galaxyRouter: router });
  const wsHandle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRouterGateway(router),
    authenticate: createTokenAuthenticate(sessions),
    revokeToken: (token) => sessions.revoke(token),
    onGameMessage: (conn, type, payload) => {
      if (!conn.systemId || !conn.playerId) return;
      const shard = router.active(conn.systemId)?.shard;
      if (!shard) return;
      routeGameMessage(shard, conn, type, payload);
    },
  });
  attachShipSwapBroadcast(shipSwapBus, wsHandle.connections, repo);
  const stopReaper = router.startReaper();
  const stopFlush = router.startPeriodicFlush(env.SHARD_FLUSH_INTERVAL_MS);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const close = async (): Promise<void> => {
    stopReaper();
    stopFlush();
    await router.stopAll();
    await wsHandle.close().catch(() => {});
    await app.close().catch(() => {});
  };
  return {
    router,
    close,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${env.WS_PATH}`,
  };
}

async function claim(httpUrl: string, callsign: string): Promise<Player> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  if (res.status !== 201) throw new Error(`claim ${callsign} failed: ${res.status}`);
  return (await res.json()) as Player;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** heapUsed in MB, after a synchronous GC (NODE_OPTIONS=--expose-gc). */
function heapMb(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Resolve a warp by its outcome: 'ok' (warp_arrived) or the error code. */
function expectWarp(c: LoadClient, dest: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      offArr();
      offErr();
      resolve(v);
    };
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    const offArr = c.on('warp_arrived', () => settle('ok'));
    const offErr = c.on('error', (p) => settle((p as { code?: string }).code ?? 'error'));
  });
}

async function main(): Promise<void> {
  const { A, B } = pickSystems();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-load-'));
  const server = await bootServer(dir);
  let exitCode = 0;
  const report: Record<string, unknown> = {
    mode: SMOKE ? 'smoke' : 'full',
    startedAt: new Date().toISOString(),
    durationMs: DURATION_MS,
    systems: { A: A.systemId, B },
    assertions: [] as Array<{ name: string; pass: boolean; detail: string }>,
  };
  const assert = (name: string, pass: boolean, detail: string): void => {
    (report.assertions as Array<{ name: string; pass: boolean; detail: string }>).push({ name, pass, detail });
    if (!pass) exitCode = 1;
  };
  let unhandledRejections = 0;
  process.on('unhandledRejection', () => {
    unhandledRejections += 1;
  });

  // --- players + clients -------------------------------------------------
  const players: Player[] = [];
  for (let i = 0; i < N_PLAYERS + 1; i++) {
    players.push(await claim(server.httpUrl, `load-${SMOKE ? 's' : 'f'}-${String(i).padStart(2, '0')}`));
  }
  const roles: Role[] = [
    ...Array(8).fill('flying'),
    ...Array(4).fill('foot'),
    ...Array(2).fill('warper'),
    ...Array(2).fill('idle'),
  ];
  const clients = roles.map((r, i) => new LoadClient(server.wsUrl, i, r));
  for (const c of clients) {
    // Production flow: join HOME, then warp to A (join_system into a foreign
    // system is a warp-shaped move for the ship row — the warp path is the
    // one that repositions it at the spawn gate).
    await c.join(players[c.id].token, players[c.id].homeSystemId);
    if (players[c.id].homeSystemId !== A.systemId) {
      c.send('warp', { destinationSystemId: A.systemId });
      const result = await expectWarp(c, A.systemId, 15_000);
      if (result !== 'ok') throw new Error(`setup warp to A failed for client ${c.id}: ${result}`);
    }
  }
  const shardA = server.router.active(A.systemId)?.shard;
  if (!shardA) throw new Error('shard A not active after joins');

  // --- foot setup: dock at the pad, disembark, seed deposits --------------
  const drivers: Array<RoleDriver | null> = clients.map(() => null);
  const peerCallsigns = new Set(players.slice(0, N_PLAYERS).map((p) => p.callsign));
  for (const c of clients) {
    if (c.role !== 'foot') continue;
    const p = players[c.id];
    shardA.teleportForTesting(p.playerId, A.pad);
    // Pad dock (surface regime, slow, at pad height) sets entity.padId — that
    // is what handleExitShip checks; the 'docked' flag is a different thing.
    for (let i = 0; i < 150 && shardA.entities.get(p.shipId)?.padId === undefined; i++) await sleep(100);
    const shipEnt = shardA.entities.get(p.shipId);
    if (!shipEnt?.padId)
      throw new Error(`client ${c.id}: ship never pad-docked (regime=${shipEnt?.ship.regime})`);
    c.send('exit_ship', { shipId: p.shipId });
    const charKey = `char:${p.playerId}`;
    for (let i = 0; i < 100 && !shardA.entities.has(charKey); i++) await sleep(100);
    const charEnt = shardA.entities.get(charKey);
    if (!charEnt)
      throw new Error(
        `exit_ship did not create a character for client ${c.id}: ` +
          `errs=${JSON.stringify(c.errCodes)} ship={padId:${shipEnt.padId} ` +
          `regime:${shipEnt.ship.regime} disembarked:${shipEnt.disembarked}}`,
      );
    const charPos = { ...charEnt.ship.pos };
    const deposits = [
      shardA.addDepositForTesting({ x: charPos.x + 1, y: charPos.y, z: charPos.z }, 300, 'iron'),
      shardA.addDepositForTesting({ x: charPos.x + 2, y: charPos.y, z: charPos.z }, 300, 'iron'),
    ];
    drivers[c.id] = createRoleDriver(c, c.role, {
      peerCallsigns,
      selfCallsign: p.callsign,
      deposits,
      terminalPos: A.terminal,
      charHome: charPos,
      teleportChar: (pos) => {
        shardA.teleportCharacterForTesting(p.playerId, pos);
      },
    });
  }
  for (const c of clients) {
    if (drivers[c.id] === null) {
      drivers[c.id] = createRoleDriver(c, c.role, {
        peerCallsigns,
        selfCallsign: players[c.id].callsign,
      });
    }
  }
  await sleep(2_000); // settle: the first role cadences are flowing

  // --- run ----------------------------------------------------------------
  const t0 = performance.now();
  const heapStart = heapMb();
  let ticks = 0;
  let lastTickAt = 0;
  let stall = 0;
  let maxStall = 0;
  shardA.events.on('tick', () => {
    ticks += 1;
    const now = performance.now();
    if (lastTickAt > 0 && now - lastTickAt > TICK_DT_MS * 1.5) {
      stall += 1;
      maxStall = Math.max(maxStall, stall);
    } else {
      stall = 0;
    }
    lastTickAt = now;
  });

  const warpers = clients.filter((c) => c.role === 'warper');
  const footers = clients.filter((c) => c.role === 'foot');
  const warpLog: Array<{ t: number; to: string; result: string }> = [];
  const rejoinGaps: number[] = [];
  const consistency: Array<{ client: number; dups: number; missingShips: number }> = [];
  let capDone = false;
  let warpIdx = 0;
  let reconnectDone = false;
  const capProbe = { rejected: false, code: null as string | null, systemAConnections: 0, totalInShards: 0 };

  const timer = setInterval(() => {
    const t = performance.now() - t0;
    for (const c of clients) drivers[c.id]!.step(performance.now());
    if (!capDone && t >= CAP_PROBE_MS) {
      capDone = true;
      void (async () => {
        const probe = new LoadClient(server.wsUrl, 17, 'idle');
        try {
          capProbe.code = await probe.join(players[16].token, A.systemId, true);
        } catch (err) {
          capProbe.code = `exception: ${String(err)}`;
        }
        capProbe.rejected = capProbe.code === 'system-full';
        capProbe.systemAConnections = server.router.active(A.systemId)!.shard.connections.size;
        capProbe.totalInShards = server.router.stats().reduce((s, x) => s + x.players, 0);
        probe.close();
      })();
    }
    if (!SMOKE) {
      while (warpIdx < WARP_TIMES.length && t >= WARP_TIMES[warpIdx]) {
        const dest = warpIdx % 2 === 0 ? B : A.systemId;
        warpIdx += 1;
        void (async () => {
          for (const w of warpers) {
            w.send('warp', { destinationSystemId: dest });
            warpLog.push({ t, to: dest, result: await expectWarp(w, dest, 15_000) });
          }
        })();
      }
      if (!reconnectDone && t >= RECONNECT_MS) {
        reconnectDone = true;
        void (async () => {
          for (const c of footers) {
            rejoinGaps.push(await c.reconnect(players[c.id].token, A.systemId));
            drivers[c.id]!.rejoin();
            await sleep(800); // let a fresh snapshot land
            const frame = c.lastFrame;
            if (frame) {
              const dups = frame.ids.length - new Set(frame.ids).size;
              const missing = players
                .slice(0, N_PLAYERS)
                .filter((p) => p.callsign !== players[12].callsign && p.callsign !== players[13].callsign)
                .filter((p) => !frame.byCallsign.get(p.callsign)?.some((e) => e.kind === 'ship'))
                .length;
              consistency.push({ client: c.id, dups, missingShips: missing });
            }
          }
        })();
      }
    }
  }, 100);

  await sleep(DURATION_MS);
  clearInterval(timer);
  const now = performance.now();
  for (const c of clients) c.close();

  // --- report --------------------------------------------------------------
  const flyingRtt = clients
    .filter((c) => c.role === 'flying')
    .reduce((acc, c) => {
      const w = c.rttWindow();
      acc.n += w.n;
      acc.samples.push(...c.rtts);
      return acc;
    }, { n: 0, samples: [] as number[] });
  const allSizes = clients.reduce((acc, c) => acc.concat(c.msgSizes), [] as number[]);
  report.clients = clients.map((c) => ({
    id: c.id,
    role: c.role,
    snapshots: c.snapshotCount,
    snapshotRateHz: Number(c.snapshotRate(now).toFixed(2)),
    maxSnapshotGapMs: Math.round(c.maxSnapshotGapMs),
    p95MsgBytes: percentile(c.msgSizes, 0.95),
    rtt: c.rttWindow(),
    kicks: c.kickCodes,
    unexpectedErrors: c.unexpectedErrors,
    rejoinGapsMs: c.rejoinGapsMs.map(Math.round),
  }));
  report.aggregate = {
    p95MsgBytes: percentile(allSizes, 0.95),
    flyingRtt: { p50: percentile(flyingRtt.samples, 0.5), p95: percentile(flyingRtt.samples, 0.95), max: percentile(flyingRtt.samples, 1), n: flyingRtt.n },
    tickHz: Number((ticks / ((now - t0) / 1000)).toFixed(2)),
    maxStallStreak: maxStall,
    heapStartMb: Number(heapStart.toFixed(1)),
    heapEndMb: Number(heapMb().toFixed(1)),
    heapDeltaMb: Number((heapMb() - heapStart).toFixed(1)),
    unhandledRejections,
    capProbe,
    warps: warpLog,
    reconnect: { gapsMs: rejoinGaps.map(Math.round), consistency },
    tickHistogram: {
      p95Ms: Number(shardA.histogram.percentile(0.95).toFixed(2)),
      trimmedP95Ms: Number(shardA.histogram.trimmedPercentile(0.95, 10).toFixed(2)),
      ...shardA.histogram.range(),
      samples: shardA.histogram.sampleCount,
    },
  };

  // --- assertions ----------------------------------------------------------
  const rates = clients.map((c) => c.snapshotRate(now));
  const minRate = Math.min(...rates);
  assert('snapshot-rate', minRate >= 9.5, `min ${minRate.toFixed(2)} Hz across 16 clients (>= 9.5)`);
  assert('cap-17th', capProbe.rejected && capProbe.systemAConnections === 16 && capProbe.totalInShards === 16, JSON.stringify(capProbe));
  if (!SMOKE) {
    const worstGap = Math.max(...clients.map((c) => c.maxSnapshotGapMs));
    assert('no-starvation', worstGap < 2_000, `worst snapshot gap ${Math.round(worstGap)} ms (< 2000)`);
    assert('p95-msg-size', percentile(allSizes, 0.95) < 16 * 1024, `p95 ${percentile(allSizes, 0.95)} B (< 16384)`);
    const rttP95 = percentile(flyingRtt.samples, 0.95);
    assert('rtt-p95', rttP95 < 100, `flying p95 ${rttP95.toFixed(1)} ms (< 100), p50 ${percentile(flyingRtt.samples, 0.5).toFixed(1)} ms, n=${flyingRtt.n}`);
    const tickHz = ticks / ((now - t0) / 1000);
    assert('tick-rate', tickHz >= 15 && maxStall <= 5, `${tickHz.toFixed(2)} Hz (>= 15), max stall streak ${maxStall} (<= 5)`);
    const kicked = clients.filter((c) => c.kickCodes.length > 0 || c.unexpectedErrors.length > 0);
    assert(
      'no-kicks',
      kicked.length === 0 && unhandledRejections === 0,
      `kicked=${JSON.stringify(kicked.map((c) => ({ id: c.id, kicks: c.kickCodes, errs: c.unexpectedErrors })))}, unhandledRejections=${unhandledRejections}`,
    );
    const heapDelta = heapMb() - heapStart;
    assert('heap', heapDelta < 30, `delta ${heapDelta.toFixed(1)} MB (< 30)`);
    const allRejoined = rejoinGaps.length === 4 && rejoinGaps.every((g) => g <= 3_000);
    const allConsistent =
      consistency.length === 4 && consistency.every((x) => x.dups === 0 && x.missingShips === 0);
    assert('reconnect', allRejoined && allConsistent, `gaps=${JSON.stringify(rejoinGaps.map(Math.round))}ms, consistency=${JSON.stringify(consistency)}`);
  }

  const reportPath = path.join(os.tmpdir(), `drift-load-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const failed = (report.assertions as Array<{ name: string; pass: boolean }>).filter((a) => !a.pass);
  console.log(`\nTASK-18 ${SMOKE ? 'SMOKE' : 'LOAD'} REPORT (${(now / 1000).toFixed(1)} s)`);
  for (const a of report.assertions as Array<{ name: string; pass: boolean; detail: string }>) {
    console.log(`  ${a.pass ? 'PASS' : 'FAIL'}  ${a.name}: ${a.detail}`);
  }
  console.log(`  report: ${reportPath}`);
  console.log(failed.length === 0 ? '  RESULT: GREEN' : `  RESULT: RED (${failed.length} failed)`);

  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('load harness crashed:', err);
  process.exit(1);
});
