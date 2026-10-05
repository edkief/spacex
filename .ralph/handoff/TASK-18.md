# TASK-18 handoff — 16-player 30-minute load/stability test

## Status
Implementation is COMPLETE and smoke-verified: the last RED assertion (p95-msg-size, 25.4 KB vs the 16 KB gate) is fixed by compressing the 10 Hz `entity_update` wire (commit `1eeb9de`), and the 35.5 s smoke run is GREEN with **p95 14,914 B / max 15,243 B** — all that remains is the 5-minute full run, a full unit-suite re-run, and the close-out bookkeeping (one invocation of work).

## Done
Everything in the prior handoff (harness, foot-setup/dock-wait fix, the 10 s `'ping'` idle heartbeat vs the server's 45 s inbound-activity keepalive, `invalid-target` as an expected combat error, the size root-cause) PLUS this iteration's wire compression — all committed as `1eeb9de perf(TASK-18): compress the 10 Hz entity_update wire`:

- `app/src/shared/protocol/schemas.ts` — `entityStateSchema`: `vel`, `regime`, `hull`, `shields`, `targetId`, `inventory` now `.optional()` (`rot`/`flightRegime` already were). New types: `WireEntityState` (loose wire form, `z.infer` of the schema) vs `EntityState` (normalized consumer view, with `vel`/`regime`/`targetId`/`hull`/`shields` required) + `normalizeEntityState()` — the ONE place defaults are re-applied. Contract documented in the schema's block comment: zero vel → omitted, identity rot → omitted, static kinds skip regime/flightRegime, full hull/shields (1) omitted, null targetId omitted, empty inventory omitted, floats ride at 3 decimals (≤ 1 mm / rad). The frame stays a FULL state — deviations are always sent, no delta encoding.
- `app/src/server/shard/shard.ts` — `entityToState` emits the compressed form (helpers `roundVec`/`roundQuat`, `STATIC_WIRE_KINDS = {deposit, terminal, groundItem, wreck, drone}` skip regime+flightRegime; `ai-ship` keeps regime but skips flightRegime). `snapshot()`, `broadcast()`, `persist` signatures → `WireEntityState[]`.
- `app/src/server/shards.ts` — `shipToEntity` (swap/livery single-entity broadcasts) uses the same compression.
- `app/src/server/shard/types.ts` — `Shard.persist` type updated.
- `app/src/client/main.tsx` — normalizes ONCE per batch at both ingest boundaries: the 10 Hz `entity_update` handler (`entities.map(normalizeEntityState)`) and `onSnapshot` (join / warp_arrived / reconnect resync all flow through it). Every downstream consumer (prediction, regime wiring, HUD, raycast, presence, targeting, remote entities) is unchanged.
- Wire-contract test updates (7 files): `schemas.test.ts` (NEW describe `entity_state compression (TASK-18)` — compressed static deposit parses, compressed at-rest ship parses, deviations still sent + normalize round-trip, all defaults re-applied, validation NOT loosened: hull 1.5 / bad regime still rejected); `shard.test.ts` (at-rest ship: `targetId`/`rot`/`vel` ABSENT on the wire, normalize re-applies); `shard.damage.test.ts` (asserts on normalized wire batch); `shard.targeting.test.ts` (`stateOf` normalizes); `shard.ai.test.ts` + `ship-swap.ws.test.ts` (`e.hull ?? 1`); `crash-restart.test.ts` (`e.hull ?? 1`); `galaxy/inventory.ws.test.ts` (empty inventory now `?? {stacks:{},weightUsed:0}`).
- `app/tests/load/harness.ts` — report gains `p50MsgBytes`/`maxMsgBytes` per client + aggregate.

## Working tree
CLEAN — everything is committed (`1eeb9de` on top of `9cfecc0`). `npx tsc --noEmit` clean at commit time. eslint + prettier clean on all touched files. `npm run load:smoke` GREEN after the change (35.5 s: snapshot-rate 9.96 Hz, cap-17th holds, p95 14,914 B / max 15,243 B — report `/tmp/drift-load-report-1791221675401.json`; /tmp is ephemeral, the numbers are in this handoff). NOT yet re-run after the change: the full 5-min `npm run load` and the full `npm run test` unit suite. Note: `src/client/test/transitionCycle.test.ts` (the 4 ms transition-budget bench) fails on THIS machine with ~19–44 ms p99 deltas — it fails IDENTICALLY at pristine HEAD (verified by git-stash, 3/3 runs) and is the documented load-flake family (wall-clock headless render on this 4-core shared VM; LOG entries for TASK-60/TASK-59 record the same). It imports nothing from the touched files. Do not chase it.

## Next steps
In order (one invocation):
1. `cd app && npx tsc --noEmit` (expect clean) and `npm run test` — expect all green EXCEPT the transitionCycle flake above. If any NEW failure appears it is a missed wire-default assertion; fix it the same way as the 7 files listed under Done (`?? <default>` or normalize first — never by re-adding the field to the wire).
2. `npm run load` (5 min, real server + 16 real sockets). Expect all 9 assertions PASS. Headroom over the 16,384 B bound is ~1.2 KB (smoke max was 15,243). If p95 creeps over 16 KB in the full run (more combat: projectiles, ground items, damaged entities), the next knobs, same pattern in `entityToState` + the schema doc: omit `energy` when it is 100, or round pos/vel to 2 decimals.
3. Record the final metrics (the report JSON lands in `/tmp/drift-load-report-*.json`; cite p50/p95/max message bytes, RTT percentiles, tick histogram, heap delta for TASK-61).
4. Close out: set steps 1–4 `pass: true` in `.ralph/tasks/TASK-18.json`, `"passes": true` for TASK-18 in `.ralph/tasks.json`, LOG.md entry at top + bump 'Tasks Completed', **delete this handoff file in the same commit**, Conventional Commit.

## Dead ends
- The p95 size was NOT a harness artifact, NOT projectile bursts, NOT a single client — it was steady-state boilerplate on ~60 entities per 10 Hz frame (root-caused in the prior handoff; see `/tmp/snap-sample.json` if it still exists: 24.5 KB frame = 26 drones × ~325 B + 16 ships + 9 deposits + 3 terminals, each carrying zero vel / identity quat / full hull+shields / null targetId / regime fields).
- Delta encoding / a custom binary frame was rejected as too large a change (step-3 says "apply the next optimization" — the static-default omission IS the optimization, and it passes the gate with ~1.2 KB to spare).
- Making `rot` required-normalized in `EntityState` broke many test call sites for nothing — its identity-default contract predated this task and consumers already handle it; `normalizeEntityState` leaves `rot` optional by design.
- Pre-existing, not mine: `transitionCycle.test.ts` budget failure (see Working tree).

## How to verify
- `cd app && npx tsc --noEmit` — clean at commit time.
- `npm run load:smoke` — PASS snapshot-rate (9.96 Hz), PASS cap-17th, RESULT: GREEN; report lines `p50MsgBytes`/`p95MsgBytes`/`maxMsgBytes` (measured 304 / 14,914 / 15,243).
- `npm run load` — 5 min; ALL 9 assertions must PASS (this is the outstanding gate).
- `npm run test` — unit suite; only the documented transitionCycle environment flake should be red on this VM.
- Wire compression unit proof: `npx vitest run src/shared/protocol/schemas.test.ts` — the `entity_state compression (TASK-18)` describe.
