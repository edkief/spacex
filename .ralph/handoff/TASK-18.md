# TASK-18 handoff — 16-player 30-minute load/stability test

## Status
Harness is green on 8 of 9 assertions in the full 5-min run (run at commit time — see `git log`, report JSON in /tmp/drift-load-report-*.json). One assertion remains RED: **p95-msg-size (26 KB > 16 KB)**. Root-caused this iteration (below); it is a wire-format tuning problem, scoped for the next iteration. The smoke run is GREEN (snapshot-rate + cap-17th).

## Done (this iteration)
- Fixed the foot-setup crash (handoff from the prior attempt): wait on the SHARD directly — `shardA.entities.has(char:${playerId})` with a hard cap + throw, instead of the wire frame.
- **Root-caused and fixed the mass drop of the 4 idle-ish clients** (warper ×2 + idle ×2 stopped receiving snapshots at t≈55 s, all 4 scheduled warps timed out, the cap probe found only 12 connections and its join succeeded): the server's WS keepalive (ws.ts) drops any connection with **no INBOUND activity for 45 s** (`DROP_AFTER_MS`, `lastActivityAt` set only in `onRawMessage`) via `socket.terminate()` (silent — no close code, the client never even records a kick). Flying/foot clients send 10 Hz input so they were fine; the warper/idle drivers sent nothing after join. Fix: `idleDriver(client)` in `app/tests/load/roles.ts` now sends a protocol `'ping'` every 10 s (valid no-op frame, accepted by the server, refreshes `lastActivityAt`). This was the single bug behind the snapshot-rate, cap-17th, and warp-timeout failures.
- Also fixed the dock wait in harness foot-setup: pad dock sets `entity.padId` (the `docked` flag is something else); the loop now waits on `padId` and throws with diagnostics (regime/errs) if it never docks.
- `no-kicks` false alarm: flying clients legitimately receive `invalid-target` (the re-aim every 5 s can lock a ship that died between snapshot read and lock request). `LoadClient.EXPECTED_ERRORS = {'invalid-target'}` now keeps it out of `unexpectedErrors`.
- Added temporary DIAG instrumentation to `harness.ts` (keep it, it's useful): 15 s census of shard connection counts + per-client last-frame age; permanent late-arrival listeners on warpers (`warp_arrived`/`error` with timestamps); cap-probe logging incl. whether the probe received `enter_system`; and `LoadClient.lastRawSnapshot` (last raw entity_update frame) dumped to `/tmp/snap-sample.json` at t=15 s for size analysis.

## The one remaining failure: p95 message size
Acceptance: p95 inbound message < 16 KB. Measured: **p95 ≈ 26 KB**, and it's the 10 Hz `entity_update` itself (every client, whole run — not an artifact). Snapshot composition at t=15 s of the full run (`/tmp/snap-sample.json`, 24.5 KB envelope, 67 entities):

| kind      | count | bytes  | notes |
|-----------|-------|--------|-------|
| drone     | 26    | 8.3 KB | seeded hazard drones (TASK-48 exposure pool); ~325 B EACH, ~80% of it boilerplate |
| ship      | 16    | 8.6 KB | ~540 B each after livery/inventory; UUID ids, full quat, livery 3 colors, inventory |
| ai-ship   | 8     | 3.8 KB | same boilerplate |
| deposit   | 9     | 2.7 KB | STATIC: full vel/rot/regime/hull/shields/targetId boilerplate for zero-valued fields |
| character | 4     | 2.0 KB | |
| terminal  | 3     | 0.9 KB | static boilerplate |
| wreck     | 1     | 0.5 KB | |

Every entity carries `vel`, `rot` (full 4-float quat even when identity 0,0,0,1), `regime`, `flightRegime`, `hull`, `shields`, `targetId: null`, `classId` — for deposits/terminals/drones these never change and are often zero-valued. The wire contract is zod-validated server-side (`messageSchemas.entity_update.safeParse` in `broadcast()`) and parsed by the client, so any field-presence change is a PROTOCOL change (shared schema + client parser + both sides' tests), not a harness tweak.

### Suggested tuning options for the next iteration (pick one, smallest first)
1. **Omit zero/identity boilerplate on static kinds** (deposit/terminal/wreck/drone-at-rest): vel omitted when all-zero, rot omitted when identity, skip `flightRegime`/`regime` when the kind is inherently static. Schema: make those fields `.optional()`. Biggest cheap win (drone+deposit+terminal ≈ 12 KB → ~4 KB).
2. **Compact player entities**: livery 3 hex colors (~55 B) → 1 packed field; inventory `{stacks:{},weightUsed:0}` when empty → omit (`.optional()`); `targetId: null` → omit. ~120 B × 20 entities ≈ 2.5 KB.
3. If 1+2 still miss: cap the drone exposure pool per system, or delta-encode entity_updates (larger project).
Re-run gate after tuning: `npm run load:smoke` (fast) then `npm run load` (5 min) — ALL 9 assertions must PASS. Then close out per the original plan (step flags, tasks.json, LOG.md, delete handoff).

## Run 3 results (full 5-min, with all fixes but pre-size-tuning)
Expected pattern: snapshot-rate PASS, cap-17th PASS, no-starvation PASS, **p95-msg-size FAIL (~26 KB)**, rtt-p95 PASS (~92 ms), tick-rate PASS (20 Hz, stall 0), no-kicks PASS, heap PASS (delta ~ -2 MB), reconnect PASS (gaps ~10 ms, 0 dups/missing).

## How to verify
- `cd app && npx tsc --noEmit`
- `npm run load:smoke` — PASS snapshot-rate, PASS cap-17th, RESULT: GREEN
- `npm run load` — 5 min; only p95-msg-size should fail until the wire tuning lands
- `npm run test` — unit suite unaffected (new dir, vitest include patterns don't pick tests/load up)

## Decisions (do not relitigate)
- `'invalid-target'` is an EXPECTED error in the combat role, not a failure signal.
- Warper/idle clients keep a 10 s `'ping'` heartbeat — that is what a real client does (the server's 45 s inbound-activity keepalive is correct production behavior, not a bug).
- Warpers have no gameplay driver between warps (the warp cadence IS their role, orchestrated by the harness) — acceptable per spec.

## Dead ends (cumulative)
- WARP loop: `join_system` into a foreign system deadlocks; production flow is join HOME → `warp` to A (already in the harness).
- The foot-setup crash was NOT a wire/shard desync — it was the dock wait checking the wrong flag (`docked` vs `padId`) plus reading the entity before confirming it exists.
- The idle-client drop is NOT a shard/router bug: it is the WS 45 s inbound-activity keepalive (silent `terminate()`, no close code).
