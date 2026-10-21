# TASK-18 handoff — 16-player load test over real WebSockets

## Status

**Partially complete; `passes` reverted to `false` at the end of this iteration.**
The harness, the production-boot extraction and both performance bugs it exposed are
committed and green. One acceptance rule fails under a scenario the harness added late:
**a client that warps between systems leaves its connection registered in the source
shard's `connections` map**, so the probed system's occupancy reads 17 instead of 16.

## Done (all committed)

- `app/src/server/runtime.ts` — `startRuntime()`: the entire production boot path
  extracted out of `app/src/server/index.ts` (which is now a thin CLI wrapper). The load
  harness boots the same function with `port: 0` + a temp-file SQLite DB.
- `app/tests/load/{client,harness,report,load.test}.ts` — the harness: 16 real `ws`
  clients (8 flying+firing, 4 on foot+mining, 2 warping every 60 s, 2 idle), the
  17th-client cap probe, the 4-client reconnect wave, input→ack RTT off the TASK-14
  `lastAppliedSeq` echo, starvation / frame-size / tick / heap / kick / consistency gates.
- `app/scripts/load.ts` + `npm run load` (5 min) and `npm run load:smoke` (30 s).
- **Bug 1 fixed:** `galaxy/router-load.ts` created shards with `broadcast: () => undefined`
  → production shipped **zero** `entity_update` frames. Now a real `SnapshotBroadcaster`
  (10.00 Hz measured).
- **Bug 2 fixed:** the 10 Hz frame was 47.8 KB (76 % = 120 unchanged deposits).
  `buildDynamicSnapshotEntities()` now serves the tick broadcast (static `deposit` /
  `terminal` kinds skipped), `buildSnapshotEntities()` still ships everything on
  join/warp, and the new `shard/deposit-update.ts` pushes a one-entity `entity_update`
  to in-range connections from the mining award path. **Frame 15.0 KB p95.**
- Tests: `src/server/shard/static-snapshot.test.ts` (3) + `tests/load/load.test.ts`.
  Server suite **1029/1029**; `tsc --noEmit` clean; eslint 0 errors; prettier applied.

### Measured (dev box, 5-minute run, 16 real sockets)

| metric | measured | budget |
|---|---|---|
| snapshot rate (worst client) | 10.00 Hz | ≥ 9.5 Hz |
| worst starvation gap | 210 ms | ≤ 2000 ms |
| frame size p95 | 15 000 B (was 47.8 KB) | < 16 384 B |
| effective tick rate | 20.01 Hz (p95 tick 1.00 ms, catch-up run 0) | ≥ 15 Hz |
| input→ack RTT | p50 48.0 ms / p95 94.9 ms (26 960 samples) | p95 < 100 ms |
| heap growth (5 min) | −36.5 MB | < 30 MB |
| reconnect wave | 4 clients rejoined, entity list matches the shard | consistent |
| kicks / unhandled rejections | none | none |
| **17th-client cap** | **rejected `system-full`, but the probed shard reads 17 occupants** | exact 16 |

## Working tree

Clean — everything is committed (`a6935ea`, `989462d`). `.ralph/tasks.json` has
TASK-18 `passes: false`. Delete the scratch file `app/warprace-tmp.mts` if it is still
present (it was committed by accident in the last commit; it is only a driver for a
75-second warp-race scenario).

## Next steps

1. **Fix the warp connection leak** (the blocker). In
   `app/src/server/galaxy/warp-resolver.ts`, `router.leaveSystem(fromSystemId, connId)`
   runs *before* `router.joinSystem(toSystemId, ctx)` (lines ~184 / ~202). Confirm that
   the WS `warp` handler passes the **same** `connId` to both calls — if it mints a new
   one, the old entry is never removed and `shard.connections.size` grows monotonically.
   Cheapest reproduction:
   `cd app && npx tsx warprace-tmp.mts` (75 s, warp at 60 s, probe at 66 s) and watch
   `cap probe: ... router=NN`.
   Second candidate: the close hook in `galaxy/ws-router-bridge.ts` — a socket that
   closes while its connection is mid-warp may never reach `leaveSystem`.
2. Re-run `npm run load` (5 min) and confirm the probed shard sits at exactly 16.
3. Then flip `.ralph/tasks.json` → `passes: true` and trim the log entry.
4. Optional performance follow-up (recorded for TASK-61): RTT p95 is 93–95 ms against a
   100 ms budget. The dominant term is the per-connection `JSON.stringify` in
   `buildConnSender`; the sim already hands the broadcaster a pre-encoded `encoded.json`
   (4th `SnapshotBroadcaster` arg, TASK-60) — threading it through to the raw socket
   write would remove 16 serialises per tick.

## Dead ends

- **Interest management / distance culling** for the frame size: unnecessary. Dropping
  the *static* entity kinds from the tick broadcast alone took 47.8 KB → 15.0 KB and
  left every dynamic entity on the wire.
- **Polling the router-wide `totalPlayers` for the cap assertion** — it is polluted by
  in-flight warps *and* by the leak above, so it cannot prove the cap. The gate now
  reads the probed shard's own occupancy plus a direct membership check (the probe's
  player id must appear in no shard).
- Sampling `v8.getHeapStatistics()` before the clients are seated measures warm-up, not
  growth (it read +41 MB once). The harness samples after seating; the 5-minute numbers
  are net-negative.

## How to verify

```bash
cd /workspace/master/app
npx tsc --noEmit                       # clean
npx vitest run src/server              # 1029/1029
npm run load:smoke                     # 30 s, 16 clients — all 10 gates green
npm run load                           # 5 min acceptance — currently 9/10, cap red
npx tsx warprace-tmp.mts               # 75 s warp race — reproduces the 17th-occupant read
```