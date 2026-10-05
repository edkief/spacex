# TASK-18 handoff — 16-player 30-minute load/stability test

## Status
The p95-msg-size failure (the last RED assertion, 25.4 KB vs 16 KB) is **fixed and smoke-verified**: the wire format was compressed (committed in this worktree — see `git log`, `perf(TASK-18)` commit). Smoke run (35.5 s, real server + 16 real sockets) is GREEN: snapshot-rate 9.96 Hz, cap-17th holds, **p95 14,914 B / max 15,243 B (< 16,384)** — report `/tmp/drift-load-report-1791221675401.json`. The 5-min full run has NOT been re-run with the compression (one 5-min invocation is all that's left, plus the close-out bookkeeping). Unit suite: 7 wire-contract test files updated; full `npm run test` not yet re-run post-fix (tsc clean; the two visible failure files + 3 more fixed and lint/prettier clean).

## Done (this iteration — wire compression)
**Root fix (option 1+2 from the prior handoff, one coherent protocol change):**
- `shared/protocol/schemas.ts` — `entityStateSchema` compressible fields are now `.optional()`: `vel` (omitted at rest → {0,0,0}), `rot` (already optional, still identity-defaulted), `regime` (omitted for static kinds → 'sublight'), `flightRegime` (only player ship/character entities carry it now — no tracker reads drone/deposit/wreck/terminal/groundItem regimes), `hull`/`shields` (omitted at 1), `targetId` (omitted → null), `inventory` (omitted while empty). New `WireEntityState` (loose wire form) vs `EntityState` (normalized consumer view) + `normalizeEntityState()` — the ONE place defaults are re-applied. Full contract documented in the schema's block comment (floats ride at 3 decimals, ≤ 1 mm / rad; frame stays a FULL state, no delta encoding; deviations are always sent).
- `server/shard/shard.ts` `entityToState` — emits the compressed wire form: zero vel / identity rot / full hull+shields / null targetId / empty inventory omitted; `STATIC_WIRE_KINDS = {deposit, terminal, groundItem, wreck, drone}` skip regime+flightRegime; `ai-ship` skips flightRegime (keeps regime); pos/vel/rot rounded to 3 decimals. `snapshot()`/`broadcast()`/`persist` signatures are now `WireEntityState[]`.
- `server/shards.ts` `shipToEntity` (swap/livery single-entity broadcasts) — same compression.
- `client/main.tsx` — normalizes ONCE per batch at both ingest boundaries: the 10 Hz `entity_update` handler and `onSnapshot` (join / warp_arrived / reconnect resync all flow through it). Every downstream consumer (prediction, regime wiring, HUD, raycast, presence, targeting, remote entities) sees the full normalized shape unchanged.
- `server/shard/types.ts`, `server/galaxy/router.ts` snapshot pass-through — types updated (router passes the wire form straight into `enter_system`, which the client normalizes).
- **Measured:** t=15 s frame 24.5 KB → 15.6 KB (median); smoke p95 14.9 KB / max 15.2 KB. Biggest cuts: 26 drones × ~325 B boilerplate, 9 deposits, 3 terminals, 16 ships' empty inventories/identity rots/null targetIds.

**Test updates (wire-contract tests now assert the compressed form or normalize first):**
- `shared/protocol/schemas.test.ts` — NEW describe 'entity_state compression (TASK-18)': fully-compressed static deposit parses; compressed at-rest player ship parses; deviations still sent + normalize round-trip; every default re-applied; validation NOT loosened (hull 1.5 / bad regime still rejected).
- `shard.test.ts` (10 Hz shared-buffer test) — asserts `targetId`/`rot`/`vel` are ABSENT on the wire for the at-rest ship + normalize() re-applies; shared-buffer check now over `WireEntityState`.
- `shard.damage.test.ts` (wreck+respawn wire test) — asserts on `normalizeEntityState(...)` of the wire batch.
- `shard.targeting.test.ts` `stateOf` — normalizes the wire snapshot entry.
- `shard.ai.test.ts`, `ship-swap.ws.test.ts` — `e.hull ?? 1`, `e.shields ?? 1`.
- `crash-restart.test.ts` — `e.hull ?? 1 > 0.99`.
- `galaxy/inventory.ws.test.ts` — empty inventory asserted as `?? {stacks:{},weightUsed:0}` (now omitted on the wire).
- `tests/load/harness.ts` — report gains `p50MsgBytes`/`maxMsgBytes` per client + aggregate (for the size picture in TASK-61).

## Pre-existing environment flake (NOT this task's)
`src/client/test/transitionCycle.test.ts` 'keeps every transition under the 4 ms budget' fails on THIS machine (p99 delta 19–44 ms vs 4 ms) — verified failing IDENTICALLY at pristine HEAD 9cfecc0 via git-stash (3/3 runs). It's the documented load-flake family (wall-clock headless-render p99 on the 4-core shared VM; LOG entries for TASK-60/TASK-59 document the same). Pure client benchmark, imports nothing from the touched files. Do not chase it here.

## Next steps (small — one 5-min run + bookkeeping)
1. `cd app && npx tsc --noEmit` (clean at commit time) and `npm run test` — expect all green EXCEPT the transitionCycle flake above; if any NEW failure appears, it's a missed wire-default assertion — fix with `?? <default>` / normalize first.
2. `npm run load` (5 min). Expect all 9 PASS (p95-msg-size now ~15 KB — headroom is ~1.2 KB to the bound; if p95 creeps over 16 KB in the full run due to more combat entities (projectiles/ground items), the next knob is the same pattern: omit `energy` when 100, or round pos to 2 decimals — both ~trivial in entityToState + the schema doc).
3. Record final metrics for TASK-61 (report JSON in /tmp; LOG entry cites it).
4. Close out per the original plan: set steps 1–4 `pass: true` in `.ralph/tasks/TASK-18.json`, `"passes": true` in `.ralph/tasks.json`, LOG.md entry + bump 'Tasks Completed', **delete this handoff**, Conventional Commit.

## Decisions (do not relitigate)
- Compressing the wire (omitting static defaults + 3-decimal rounding) IS the tuning: TASK-18's step 3 says "assert every acceptance metric; if the server fails, apply the next optimization, re-run" — the snapshot-size optimization is in-task.
- `targetId: null` / `hull: 1` / empty inventory are OMITTED, not zeroed — the normalized view re-applies them; no consumer may read a wire field without normalizing (the two ingest points in main.tsx are the only boundaries).
- `'invalid-target'` is an EXPECTED error in the combat role. Warper/idle clients keep the 10 s `'ping'` heartbeat (server 45 s keepalive is correct production behavior). Warpers have no gameplay driver between warps.
- AI ships keep `regime` (sublight/docked is cheap and truthful) but drop `flightRegime` (no consumer reads it).

## Dead ends (cumulative)
- WARP loop: `join_system` into a foreign system deadlocks; production flow is join HOME → `warp` to A.
- The foot-setup crash was the dock wait checking `docked` vs `padId`, not a wire/shard desync.
- The idle-client drop was the WS 45 s inbound-activity keepalive (silent `terminate()`), not a shard/router bug.
- p95 size was NOT a harness artifact, NOT projectile bursts — it was steady-state boilerplate on ~60 entities per 10 Hz frame.
