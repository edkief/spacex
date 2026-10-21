/**
 * Load-report shapes + the acceptance assertions — TASK-18.
 *
 * Pure data + pure functions: the harness (`./harness.ts`) produces a
 * {@link LoadReport}, `evaluateReport()` turns it into a list of
 * named pass/fail checks. Keeping the assertions separate from the
 * run means the rules are unit-testable without a socket and the CLI
 * can print the same table the CI smoke run asserts.
 *
 * Thresholds (all from the task's acceptance criteria):
 *   - snapshot rate   >= 9.5 /s per client (10 Hz nominal, <= 5 % loss)
 *   - starvation      no client silent for > 2 s
 *   - message size    p95 < 16 KB
 *   - RTT             p95 < 100 ms (localhost: server processing only)
 *   - tick rate       >= 15 Hz sustained
 *   - heap growth     < 30 MB over the run
 *   - sessions        no spurious 4001 kicks
 *   - cap             17th join rejected with `system-full`, count stays 16
 */
import type { Role } from "./client.js";

/** Percentile of a numeric sample set (nearest-rank, 0-indexed by p). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank]!;
}

/** One client's measured behaviour over the run. */
export interface ClientReport {
  callsign: string;
  role: Role;
  /** `entity_update` frames received (post-join). */
  snapshots: number;
  /** Measured seconds between the first and last snapshot. */
  activeSeconds: number;
  /** `snapshots / activeSeconds`. Budget: >= 9.5. */
  snapshotHz: number;
  /** Longest silence between two snapshots (ms). Budget: <= 2000. */
  maxGapMs: number;
  /** Largest inbound `entity_update` frame (bytes). */
  maxBytes: number;
  /** p95 inbound `entity_update` frame size (bytes). Budget: < 16384. */
  p95Bytes: number;
  /** Input -> snapshot-ack RTT samples (ms). */
  rttSamples: number[];
  rttP50Ms: number;
  rttP95Ms: number;
  /** Distinct entity ids seen in the latest snapshot (client's view). */
  entityIds: number;
  /** Ids that appeared twice inside one snapshot (must stay 0). */
  duplicateEntityIds: number;
  /** `error` frames by code. */
  errorCodes: Record<string, number>;
  /** True when the server closed the socket with 4001 (spurious kick). */
  kicked: boolean;
  /** Sockets closed + reopened by the reconnect wave. */
  reconnects: number;
  /** Wall-clock ms from socket close to a fresh `enter_system`. */
  rejoinMs: number | null;
  /** Entity count of the first snapshot after the last rejoin. */
  entityCountAfterRejoin: number | null;
  /** `mining_update` frames seen (on-foot miners). */
  miningUpdates: number;
  /** Successful warps / warp attempts. */
  warpsOk: number;
  warpAttempts: number;
}

/** Shard sim telemetry sampled at the end of the run. */
export interface TickReport {
  systemId: string;
  ticks: number;
  /** Effective tick rate over the measurement window. Budget: >= 15. */
  effectiveHz: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  connections: number;
  entityCount: number;
  maxConsecutiveCatchup: number;
}

/** The 17th-client cap probe (a correctness check, kept separate). */
export interface CapProbeReport {
  attempted: boolean;
  rejected: boolean;
  code: string | null;
  /** Occupancy of the probed system shard right after the rejection. */
  routerPlayers: number;
  /** Router-wide player total (informational; moves during warps). */
  aggregatePlayers: number;
  ok: boolean;
}

/** The t=2 min reconnect wave. */
export interface ReconnectWaveReport {
  attempted: boolean;
  /** Clients dropped + rejoined. */
  clients: string[];
  maxRejoinMs: number;
  /** Post-rejoin entity-list consistency verdicts. */
  consistent: boolean;
  detail: string[];
}

/** Everything one run produced. */
export interface LoadReport {
  startedAt: number;
  durationMs: number;
  clientCount: number;
  clients: ClientReport[];
  tick: TickReport;
  heap: { startMb: number; endMb: number; growthMb: number };
  capProbe: CapProbeReport;
  reconnectWave: ReconnectWaveReport;
  /** Unhandled rejections observed in the process (must be empty). */
  unhandledRejections: string[];
  checks: LoadCheck[];
}

/** A single named acceptance gate. */
export interface LoadCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Thresholds, exported so the CLI + tests share one source of truth. */
export const LOAD_BUDGETS = {
  minSnapshotHz: 9.5,
  maxSnapshotGapMs: 2000,
  maxP95MessageBytes: 16 * 1024,
  maxRttP95Ms: 100,
  minTickHz: 15,
  maxHeapGrowthMb: 30,
  clientCap: 16,
} as const;

/**
 * Turn a report into the acceptance checks. Pure: the same report
 * always yields the same verdict, so the CLI can print it and the
 * vitest smoke run can assert on it.
 */
export function evaluateReport(report: LoadReport): LoadCheck[] {
  const checks: LoadCheck[] = [];
  const worstHz = report.clients.reduce((m, c) => Math.min(m, c.snapshotHz), Infinity);
  const worstGap = report.clients.reduce((m, c) => Math.max(m, c.maxGapMs), 0);
  const worstBytes = report.clients.reduce((m, c) => Math.max(m, c.p95Bytes), 0);
  const rttSamples = report.clients.flatMap((c) => c.rttSamples);
  const rttP95 = percentile(rttSamples, 0.95);
  const kicked = report.clients.filter((c) => c.kicked).map((c) => c.callsign);

  checks.push({
    name: "snapshot-rate",
    ok: report.clients.every((c) => c.snapshotHz >= LOAD_BUDGETS.minSnapshotHz),
    detail: `worst client ${worstHz.toFixed(2)} Hz (>= ${LOAD_BUDGETS.minSnapshotHz})`,
  });
  checks.push({
    name: "no-starvation",
    ok: worstGap <= LOAD_BUDGETS.maxSnapshotGapMs,
    detail: `worst gap ${worstGap.toFixed(0)} ms (<= ${LOAD_BUDGETS.maxSnapshotGapMs})`,
  });
  checks.push({
    name: "message-size",
    ok: worstBytes < LOAD_BUDGETS.maxP95MessageBytes,
    detail: `worst client p95 ${worstBytes} B (< ${LOAD_BUDGETS.maxP95MessageBytes})`,
  });
  checks.push({
    name: "rtt",
    ok: rttSamples.length > 0 && rttP95 < LOAD_BUDGETS.maxRttP95Ms,
    detail: `p95 ${rttP95.toFixed(1)} ms over ${rttSamples.length} samples (< ${LOAD_BUDGETS.maxRttP95Ms})`,
  });
  checks.push({
    name: "tick-rate",
    ok: report.tick.effectiveHz >= LOAD_BUDGETS.minTickHz,
    detail: `${report.tick.effectiveHz.toFixed(2)} Hz (>= ${LOAD_BUDGETS.minTickHz})`,
  });
  checks.push({
    name: "heap-growth",
    ok: report.heap.growthMb < LOAD_BUDGETS.maxHeapGrowthMb,
    detail: `${report.heap.growthMb.toFixed(2)} MB (< ${LOAD_BUDGETS.maxHeapGrowthMb})`,
  });
  checks.push({
    name: "no-spurious-kicks",
    ok: kicked.length === 0,
    detail: kicked.length === 0 ? "all sessions authenticated" : `kicked: ${kicked.join(", ")}`,
  });
  checks.push({
    name: "no-unhandled-rejections",
    ok: report.unhandledRejections.length === 0,
    detail:
      report.unhandledRejections.length === 0
        ? "clean"
        : report.unhandledRejections.slice(0, 3).join(" | "),
  });
  checks.push({
    name: "cap-enforcement",
    ok: report.capProbe.ok,
    detail: report.capProbe.ok
      ? `17th join rejected with ${report.capProbe.code}, probed shard at ${report.capProbe.routerPlayers} (router total ${report.capProbe.aggregatePlayers})`
      : `probe failed (code=${report.capProbe.code}, router=${report.capProbe.routerPlayers})`,
  });
  checks.push({
    name: "entity-consistency",
    ok: report.clients.every((c) => c.duplicateEntityIds === 0),
    detail: report.reconnectWave.detail.join("; ") || "no duplicates observed",
  });
  return checks;
}

/** True when every check passed. */
export function allGreen(checks: readonly LoadCheck[]): boolean {
  return checks.every((c) => c.ok);
}

/** One-line-per-check table for the CLI. */
export function formatReport(report: LoadReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `=== TASK-18 load test — ${report.clientCount} clients, ${(report.durationMs / 1000).toFixed(1)}s ===`,
  );
  lines.push("");
  lines.push("role          cs          snapHz  gapMs   p95B     rttP95  dup  snaps");
  for (const c of report.clients) {
    lines.push(
      `${c.role.padEnd(12)} ${c.callsign.padEnd(11)} ${c.snapshotHz.toFixed(2).padStart(6)} ` +
        `${c.maxGapMs.toFixed(0).padStart(6)} ${String(c.p95Bytes).padStart(7)} ` +
        `${c.rttP95Ms.toFixed(1).padStart(7)} ${String(c.duplicateEntityIds).padStart(4)} ` +
        `${String(c.snapshots).padStart(6)}`,
    );
  }
  const allRtt = report.clients.flatMap((c) => c.rttSamples);
  lines.push("");
  lines.push(
    `tick: ${report.tick.effectiveHz.toFixed(2)} Hz  p50=${report.tick.p50Ms.toFixed(2)}ms ` +
      `p95=${report.tick.p95Ms.toFixed(2)}ms max=${report.tick.maxMs.toFixed(2)}ms ` +
      `catchup=${report.tick.maxConsecutiveCatchup}`,
  );
  lines.push(
    `heap: start=${report.heap.startMb.toFixed(2)}MB end=${report.heap.endMb.toFixed(2)}MB ` +
      `growth=${report.heap.growthMb.toFixed(2)}MB`,
  );
  lines.push(
    `rtt: p50=${percentile(allRtt, 0.5).toFixed(1)}ms p95=${percentile(allRtt, 0.95).toFixed(1)}ms n=${allRtt.length}`,
  );
  lines.push(
    `cap probe: ${report.capProbe.code ?? "none"} router=${report.capProbe.routerPlayers}`,
  );
  lines.push(
    `reconnect wave: ${report.reconnectWave.clients.join(", ") || "-"} (max ${report.reconnectWave.maxRejoinMs.toFixed(0)} ms)`,
  );
  lines.push("");
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(24)} ${check.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}
