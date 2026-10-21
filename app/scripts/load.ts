#!/usr/bin/env tsx
/**
 * 16-player load test CLI — TASK-18.
 *
 * Boots the production server on a random port with a temp-file
 * SQLite DB, seats 16 real WebSocket clients in one system
 * (8 flying + firing, 4 on foot + mining, 2 warping every 60 s,
 * 2 idle), and asserts the acceptance metrics: snapshot rate,
 * starvation, frame size, input->ack RTT, tick rate, heap growth,
 * session auth, entity consistency after a reconnect wave, and the
 * 17th-client cap.
 *
 * Usage:
 *
 *   $ npm run load                # 5-minute acceptance run
 *   $ npm run load:smoke          # 30 s, snapshot-rate + cap rules
 *   $ LOAD_MS=60000 npm run load  # custom window
 *   $ LOAD_REPORT=/tmp/r.json npm run load
 *
 * Exit code:
 *   `0` — every check green.
 *   `1` — a check failed (the table names the culprit).
 *   `2` — the run itself failed (boot / socket error).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { runLoadScenario } from "../tests/load/harness.js";
import { allGreen, formatReport } from "../tests/load/report.js";

const SMOKE = process.argv.includes("--smoke");
const durationMs = Number.parseInt(process.env.LOAD_MS ?? (SMOKE ? "30000" : "300000"), 10);
const reportPath = process.env.LOAD_REPORT ?? path.join(process.cwd(), "data", "load-report.json");

const checkCounts = process.env.LOAD_CHECKS === "snapshot-rate,cap-enforcement";

async function main(): Promise<void> {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  console.log(
    `[load] starting ${SMOKE ? "smoke" : "acceptance"} run: 16 clients, ` +
      `${(durationMs / 1000).toFixed(0)}s, cap probe + reconnect wave enabled`,
  );
  let report;
  try {
    report = await runLoadScenario({
      durationMs,
      reportPath,
      // The smoke variant compresses the scenario: cap probe at 10 %,
      // reconnect wave at 25 % so both fire inside a 30 s window.
      relativeSchedule: true,
    });
  } catch (err) {
    console.error("[load] run failed:", err);
    process.exit(2);
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(formatReport(report));
  console.log(`[load] JSON report written to ${reportPath}`);

  if (checkCounts) {
    // Smoke mode asserts only the snapshot-rate + cap rules.
    const names = new Set(["snapshot-rate", "cap-enforcement"]);
    const green = report.checks.filter((c) => names.has(c.name)).every((c) => c.ok);
    process.exit(green ? 0 : 1);
  }
  process.exit(allGreen(report.checks) ? 0 : 1);
}

void main();
