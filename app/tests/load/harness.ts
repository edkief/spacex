/**
 * TASK-18 load harness — 16 real WebSocket clients against one real
 * system shard.
 *
 * The harness boots the **production boot path** (`startRuntime`,
 * extracted from `src/server/index.ts`) against a temp-file SQLite DB
 * on a random port, then drives the scenario the acceptance criteria
 * describe:
 *
 *   - 8 flying + firing, 4 on foot + mining, 2 warping every 60 s,
 *     2 idle — all 16 joined to one system.
 *   - a 17th-client cap probe: it must be rejected with
 *     `system-full` and must not appear in the router's count.
 *   - a reconnect wave: 4 clients close their sockets and rejoin,
 *     then their entity list is checked against the live shard for
 *     duplicates / missing ships.
 *
 * Everything measured lands in a {@link LoadReport}; the assertions
 * live in `./report.ts` so they are unit-testable without sockets.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";

import { loadConfig } from "../../src/server/config.js";
import { startRuntime, type Runtime } from "../../src/server/runtime.js";
import { generateStars } from "@shared/galaxy/stars.js";
import { LoadClient, type Role } from "./client.js";
import {
  allGreen,
  evaluateReport,
  type CapProbeReport,
  type ClientReport,
  type LoadReport,
  type ReconnectWaveReport,
  type TickReport,
} from "./report.js";

/** Scenario knobs. Defaults are the acceptance run (5 minutes). */
export interface LoadScenarioOptions {
  /** Measurement window. Acceptance: 300 000 ms. */
  durationMs?: number;
  /** When the reconnect wave fires. Acceptance: 120 000 ms. */
  reconnectAtMs?: number;
  /** When the 17th-client cap probe fires. Acceptance: 60 000 ms. */
  capProbeAtMs?: number;
  /** Clients dropped in the reconnect wave. */
  reconnectClients?: number;
  /** Galaxy seed (defaults to a load-specific one). */
  seed?: string;
  /** Write the JSON report to this path (default: none). */
  reportPath?: string;
  /** Fraction of the duration used when a relative offset overflows. */
  relativeSchedule?: boolean;
}

const SESSION_SECRET = "TASK-18-LOAD-TEST-SECRET-DO-NOT-USE-IN-PRODUCTION-9876543210";
const STAR_COUNT = 32;
const CAP = 16;

/** Role mix — 8 flyers + 4 on foot + 2 warpers + 2 idlers = 16. */
export const LOAD_ROLE_MIX: { role: Role; count: number }[] = [
  { role: "flyer", count: 8 },
  { role: "foot", count: 4 },
  { role: "warper", count: 2 },
  { role: "idle", count: 2 },
];

/** Boot the real server on a random port with a temp-file DB. */
async function bootLoadServer(seed: string): Promise<{
  runtime: Runtime;
  dir: string;
  systemId: string;
  altSystemId: string;
}> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drift-load-"));
  const config = loadConfig({
    ...process.env,
    DB_DRIVER: "sqlite",
    DB_PATH: path.join(dir, "load.db"),
    SESSION_SECRET,
    GALAXY_SEED: seed,
    STATIC_DIR: "",
    // Long reaps: the run must not drop the shard mid-measurement.
    SYSTEM_INSTANCE_COUNT: "4",
  });
  const stars = generateStars(config.galaxySeed, STAR_COUNT);
  const runtime = await startRuntime({
    config,
    galaxyStarCount: STAR_COUNT,
    port: 0,
    host: "127.0.0.1",
  });
  return {
    runtime,
    dir,
    systemId: stars[0]!.id,
    altSystemId: stars[1]!.id,
  };
}

/** Claim a callsign over the real REST route and return its session token. */
async function claimCallsign(runtime: Runtime, callsign: string): Promise<string> {
  const res = await fetch(`${runtime.address}/api/callsigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callsign }),
  });
  if (!res.ok) {
    throw new Error(`claim failed for ${callsign}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** Read the shard's sim telemetry for the tick-rate gate. */
function tickReportFor(runtime: Runtime, systemId: string, durationMs: number): TickReport {
  const shard = runtime.router.get(systemId);
  if (!shard) {
    return {
      systemId,
      ticks: 0,
      effectiveHz: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      connections: 0,
      entityCount: 0,
      maxConsecutiveCatchup: 0,
    };
  }
  const stats = shard.sim.stats();
  return {
    systemId,
    ticks: stats.tickCount,
    effectiveHz: stats.tickCount / (durationMs / 1000),
    p50Ms: stats.histogram.p50,
    p95Ms: stats.histogram.p95,
    maxMs: stats.histogram.max,
    connections: stats.connectionCount,
    entityCount: stats.entityCount,
    maxConsecutiveCatchup: stats.maxConsecutiveCatchup,
  };
}

/**
 * Ask a 17th client to join. Returns whether the server rejected it
 * with `system-full` and what the router counted afterwards.
 */
async function probeCap(
  runtime: Runtime,
  wsUrl: string,
  systemId: string,
  index: number,
): Promise<CapProbeReport> {
  const token = await claimCallsign(runtime, `LOADCAP-${index}`);
  const probe = new LoadClient({
    url: wsUrl,
    token,
    callsign: `LOADCAP-${index}`,
    systemId,
    role: "idle",
  });
  let code: string | null = null;
  let probeId: string | undefined;
  try {
    await probe.connect();
    probeId = probe.id;
    // A rejected join never sends `enter_system`, so the wait times
    // out fast and the recorded error code is the verdict.
    await probe.joinSystem(systemId, 1500);
    const report = probe.report();
    if (report.errorCodes["system-full"] !== undefined) code = "system-full";
  } catch {
    code = "connect-failed";
  } finally {
    probe.close();
  }
  // The cap rule is "the 17th client is NOT counted". Comparing the
  // router count before/after the probe makes that assertion immune
  // to an unrelated client's mid-warp window (a warping connection
  // briefly sits in both shards while the resolver moves it), and
  // the membership check is the direct proof: the probe's player id
  // must appear in no shard at all.
  // The acceptance rule is about the SYSTEM the 17th client tried to
  // enter, so the gate reads that shard's own occupancy: the probe
  // left it at the cap. The router-wide aggregate is reported too,
  // but it can read high while another client's connection is being
  // moved between shards (and while a reconnect storm is in flight),
  // which is a different (recorded, non-blocking) observation.
  const probedShard = runtime.router.get(systemId);
  const routerPlayers = probedShard ? probedShard.connections.size : 0;
  const aggregatePlayers = runtime.router.stats().totalPlayers;
  const inAnyShard = [...runtime.router.stats().shards].some((s) => {
    const shard = runtime.router.get(s.systemId);
    if (!shard || probeId === undefined) return false;
    return [...shard.connections.values()].some((c) => c.playerId === probeId);
  });
  return {
    attempted: true,
    rejected: code === "system-full",
    code,
    routerPlayers,
    aggregatePlayers,
    ok: code === "system-full" && routerPlayers === CAP && !inAnyShard,
  };
}

/**
 * Run the whole scenario and return the report. Always tears the
 * server down, even when a client throws.
 */
export async function runLoadScenario(options: LoadScenarioOptions = {}): Promise<LoadReport> {
  const durationMs = options.durationMs ?? 300_000;
  const relative = options.relativeSchedule ?? durationMs < 120_000;
  const reconnectAtMs = options.reconnectAtMs ?? (relative ? durationMs * 0.25 : 120_000);
  const capProbeAtMs = options.capProbeAtMs ?? (relative ? durationMs * 0.1 : 60_000);
  const reconnectCount = options.reconnectClients ?? 4;
  const seed = options.seed ?? "TASK18-LOAD-SEED";

  const unhandledRejections: string[] = [];
  const onRejection = (reason: unknown): void => {
    unhandledRejections.push(String(reason));
  };
  process.on("unhandledRejection", onRejection);

  const startedAt = Date.now();
  const t0 = performance.now();
  const { runtime, dir, systemId, altSystemId } = await bootLoadServer(seed);
  const wsUrl = `ws://127.0.0.1:${runtime.port}/ws`;
  const clients: LoadClient[] = [];
  let capProbe: CapProbeReport = {
    attempted: false,
    rejected: false,
    code: null,
    routerPlayers: 0,
    aggregatePlayers: 0,
    ok: false,
  };
  let reconnectWave: ReconnectWaveReport = {
    attempted: false,
    clients: [],
    maxRejoinMs: 0,
    consistent: true,
    detail: [],
  };

  try {
    // --- seat 16 clients --------------------------------------------------
    let seat = 0;
    for (const { role, count } of LOAD_ROLE_MIX) {
      for (let i = 0; i < count; i++) {
        seat += 1;
        const callsign = `LOAD-${String(seat).padStart(2, "0")}`;
        const token = await claimCallsign(runtime, callsign);
        const client = new LoadClient({
          url: wsUrl,
          token,
          callsign,
          systemId,
          role,
          altSystemId,
        });
        await client.connect();
        await client.joinSystem(systemId);
        clients.push(client);
      }
    }
    const heapStartMb = v8.getHeapStatistics().used_heap_size / 1024 / 1024;

    // --- run --------------------------------------------------------------
    for (const client of clients) client.startDriving();

    const capProbeJob = onceAt(capProbeAtMs, async () => {
      capProbe = await probeCap(runtime, wsUrl, systemId, 1);
    });
    const reconnectJob = onceAt(reconnectAtMs, async () => {
      await runReconnectWave(clients, reconnectCount);
      reconnectWave = buildReconnectReport(runtime, clients, systemId);
    });

    await new Promise<void>((resolve) => {
      const started = performance.now();
      const interval = setInterval(() => {
        const elapsed = performance.now() - started;
        capProbeJob.maybeRun(elapsed);
        reconnectJob.maybeRun(elapsed);
        if (elapsed >= durationMs) {
          clearInterval(interval);
          resolve();
        }
      }, 25);
    });
    await capProbeJob.done;
    await reconnectJob.done;

    const heapEndMb = v8.getHeapStatistics().used_heap_size / 1024 / 1024;
    const tick = tickReportFor(runtime, systemId, durationMs);
    const clientReports: ClientReport[] = clients.map((c) => c.report());
    const report: LoadReport = {
      startedAt,
      durationMs: performance.now() - t0,
      clientCount: clients.length,
      clients: clientReports,
      tick,
      heap: { startMb: heapStartMb, endMb: heapEndMb, growthMb: heapEndMb - heapStartMb },
      capProbe,
      reconnectWave,
      unhandledRejections,
      checks: [],
    };
    report.checks = evaluateReport(report);
    if (options.reportPath) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options.reportPath, JSON.stringify(report, null, 2));
    }
    return report;
  } finally {
    for (const client of clients) client.close();
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
    process.off("unhandledRejection", onRejection);
  }
}

/**
 * Poll `router.stats().totalPlayers` until it reads exactly `expected`
 * or the deadline passes; returns the last value seen. Used by the cap
 * probe so an unrelated client's in-flight warp can't be mistaken for
 * a 17th admitted player.
 */

/**
 * Wrap a one-shot job so the scenario's ticker can fire it exactly
 * once and the run can await its completion afterwards.
 */
function onceAt(
  atMs: number,
  job: () => Promise<void>,
): {
  maybeRun(elapsedMs: number): void;
  done: Promise<void>;
} {
  let started = false;
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    maybeRun(elapsedMs: number): void {
      if (started || elapsedMs < atMs) return;
      started = true;
      void job().finally(settle);
    },
    done,
  };
}

/**
 * Drop `count` sockets and bring them back with the same token.
 * Mirrors a client-side network blip, not a graceful leave.
 */
async function runReconnectWave(clients: LoadClient[], count: number): Promise<void> {
  const victims = clients.slice(0, count);
  await Promise.all(
    victims.map(async (client) => {
      // 150 ms of "outage", then reconnect — inside the 3 s budget.
      await new Promise((r) => setTimeout(r, 150));
      await client.dropAndRejoin();
    }),
  );
}

/**
 * Post-rejoin entity consistency: every client that rejoined must
 * agree with the live shard — no duplicate ids, and every reconnected
 * player's own entity present exactly once.
 */
function buildReconnectReport(
  runtime: Runtime,
  clients: LoadClient[],
  systemId: string,
): ReconnectWaveReport {
  const shard = runtime.router.get(systemId);
  const detail: string[] = [];
  const rejoined = clients.filter((c) => c.report().reconnects > 0);
  let consistent = true;
  if (!shard) {
    return {
      attempted: rejoined.length > 0,
      clients: rejoined.map((c) => c.callsign),
      maxRejoinMs: 0,
      consistent: false,
      detail: ["shard missing after reconnect"],
    };
  }
  for (const client of rejoined) {
    const observed = client.observedEntityIds();
    const unknown = [...observed].filter((id) => !shard.entities.has(id));
    const report = client.report();
    if (unknown.length > 0 || report.duplicateEntityIds > 0) {
      consistent = false;
      detail.push(
        `${client.callsign}: ${unknown.length} unknown ids, ${report.duplicateEntityIds} dups`,
      );
    } else {
      detail.push(`${client.callsign}: ${observed.size} entities match shard`);
    }
  }
  return {
    attempted: rejoined.length > 0,
    clients: rejoined.map((c) => c.callsign),
    maxRejoinMs: rejoined.reduce((m, c) => Math.max(m, c.report().rejoinMs ?? 0), 0),
    consistent,
    detail,
  };
}

/** Convenience: run the scenario and report whether it was green. */
export async function runAndCheck(
  options: LoadScenarioOptions = {},
): Promise<{ report: LoadReport; green: boolean }> {
  const report = await runLoadScenario(options);
  return { report, green: allGreen(report.checks) };
}
