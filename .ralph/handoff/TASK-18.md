# TASK-18 handoff — 16-player 30-minute load/stability test

## Status
Load harness written and typecheck-clean; the smoke run boots the real server and all 16 clients join + dock + disembark, but it crashes at harness.ts ~line 229 (foot setup): `shardA.entities.get(`char:${p.playerId}`)` is undefined — the exit_ship wait loop did not confirm the character entity on the WIRE frame before reading it from the shard. One-line-class fix, see Next steps 1.

## Done
- `app/tests/load/client.ts` — `LoadClient`: real ws, join/handshake (incl. `join(..., expectError)` for the 17th-client probe), `reconnect()`, 10 Hz `sendInput` with monotonic seq, metrics: snapshot count/rate (rejoin downtime excluded from active time), max snapshot gap, msg sizes (p95), RTT via ack-echo matching (pending inputs ≤ ack seq), per-frame entity ids + `byCallsign` (Map callsign → array of {id,kind}), kick codes (≥4000 or 1011), error code bookkeeping, `on(type, cb)` + `when(type, ms)`.
- `app/tests/load/roles.ts` — role drivers stepped at 100 ms: flying (full-thrust sinusoidal input, target_lock re-aim every 5 s from the shared snapshot, laser every ~340 ms), foot (hold mining channel: mine-start, 1 Hz mine-tick, on 'full' status teleport character to the pad terminal, sell 40 iron, teleport back, re-open channel; cycles 2 pre-seeded 300-unit deposits), warper + idle (driver no-ops; warping is orchestrated by the harness).
- `app/tests/load/harness.ts` — boots the FULL production wiring (buildServer + routes + ws + galaxy router + reaper + periodic flush) on a random 127.0.0.1 port with a tmp sqlite DB; picks system A (first with a pad) + B from seed `drift-load-seed-018`; claims 17 callsigns; clients join HOME then warp to A (production flow — see Dead ends); foot players are teleported onto the pad, dock-wait, exit_ship; runs SMOKE (30 s, `--smoke` flag) or FULL (5 min): 100 ms role-stepping interval, cap probe at 20 s (smoke) / 60 s (full) with the 17th client, warps at 90/150/210/270 s (60 s cadence A↔B), reconnect wave of the 4 foot clients at 120 s with per-client entity consistency (no dup ids, every in-A ship present); writes a JSON report to /tmp (`drift-load-report-*.json`), prints PASS/FAIL per assertion, exits 1 on any failure. Assertions: snapshot-rate ≥ 9.5 Hz min, cap-17th (system-full + shard count stays 16), no-starvation (< 2 s gap), p95 msg < 16 KB, flying RTT p95 < 100 ms, tick ≥ 15 Hz + stall streak ≤ 5, no kicks/unhandled rejections, heap delta < 30 MB (--expose-gc), reconnect gaps ≤ 3 s + consistency.
- `app/package.json` — added `load` and `load:smoke` scripts (`NODE_OPTIONS=--expose-gc tsx tests/load/harness.ts [--smoke]`).

## Working tree
UNCOMMITTED (this handoff + the work are committed together): `app/tests/load/` (3 new files), `app/package.json` (2 new scripts). `npx tsc --noEmit` passes. Nothing else touched. No unit tests affected (new dir, vitest include patterns don't pick it up).

## Next steps
1. Fix the foot-setup crash: in harness.ts the `for (...) await sleep(100)` wait loop checks `c.lastFrame?.byCallsign...kind === 'character'` but then immediately does `shardA.entities.get(`char:${p.playerId}`)!.ship.pos` — by the time the loop exits the character exists on the wire, but make it robust: wait on the SHARD directly instead (`while (!shardA.entities.has(`char:${p.playerId}`)) await sleep(100)` with a hard cap + throw). That's the line that threw `Cannot read properties of undefined (reading 'ship')`.
2. Re-run `npm run load:smoke` (~45 s incl. boot). Expect: 16 join + warp to A, 4 foot players dock/disembark, cap probe, report + PASS lines.
3. When smoke is green, run `npm run load` (5 min) — budget ~6 min. Likely first failures to debug: RTT p95 (acks only ride at 10 Hz snapshot cadence, so RTT samples are coarse 10 Hz — p95 should still be well under 100 ms on localhost; if it fails, verify inputs are being APPLIED: flying clients need a held input every 100 ms, which they have), foot mining (check the 'mining' frames arrive — the character must be within interact range of the deposit; deposits are seeded at charPos +1/+2 m), sell (character must be within TERMINAL_RANGE_M=10 of the terminal; the teleport puts it at terminal+0.5 m), heap (GC pauses can look like growth; delta is measured gc'd start vs end).
4. If the 5-min run is green: set the 4 step `pass` flags true in `.ralph/tasks/TASK-18.json`, set `passes: true` in `.ralph/tasks.json`, LOG.md entry (newest on top, note the RTT percentiles / tick histogram / heap delta from the report file for TASK-61), commit, promise.
5. NOTE for later: the warper role's "no driver" design means warpers are effectively idle between warps — acceptable per spec (their job IS the 60 s warp cadence, orchestrated by the harness).

## Dead ends
- **WARP loop (cost ~30 min of this iteration):** first harness version sent `join_system` directly into A for players whose home ≠ A. That hangs: the warp handler runs while the ship is mid-join in A and deadlocks (shard stays up, nothing resolves). Correct production flow is join HOME → `warp` to A, which is what the code now does.
- The earlier "smoke hung with no output" was that same warp hang (server log stopped after "shard loaded"), NOT a logging/pipe problem.
- diag.ts scratch file proved the single-player join works and the entity_update 10 Hz stream is healthy (used to isolate the hang).

## How to verify
- `cd app && npx tsc --noEmit` — must pass.
- `npm run load:smoke` — must print PASS snapshot-rate, PASS cap-17th, RESULT: GREEN (exit 0).
- `npm run load` — full 5 min, all 9 assertions PASS, RESULT: GREEN; report JSON in /tmp.
- `npm run test` — unit suite unaffected (should still be 104 files / ~898 passed).
