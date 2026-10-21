import { runLoadScenario } from "./tests/load/harness.js";
import { formatReport } from "./tests/load/report.js";
const report = await runLoadScenario({ durationMs: 75000, reconnectAtMs: 20000, capProbeAtMs: 66000, relativeSchedule: false });
console.log(formatReport(report));
process.exit(0);
