# TASK-38 — Mining handoff

## Status

TASK-38 (long-running mining with a 1.5 s server-timed channel) is ~95% complete:
server state machine, wire schemas, WS handler, sim-loop integration, client
hold-E prompt, radial progress UI, full unit suite (1771/1771 tests green),
and a Playwright e2e (passes). The work is uncommitted (working tree dirty).
The only loose ends are housekeeping (commit + log entry + screenshot
record). Do NOT set `passes: true` from the handoff — leave that for the
session that finalises + runs the e2e screenshot capture.

## Done

### Server (`app/src/server/`)

- `app/src/server/shard/mining.ts` (NEW, ~600 LOC): `MiningState` shape,
  `handleMineStart` / `handleMineStop` / `advanceMining` / `pushMiningUpdate`
  / `getMiningState` / `clearMiningFor` / `maybeResumeMining`. Cadence is
  `MINE_TICK_MS = 1500`. Awards are **server-timed, not message-timed**
  (anti-spam — the spam test asserts the floor).
- `app/src/server/shard/mining.test.ts` (NEW): 20 cases covering range /
  regime / depleted / already-mining / cancel / single cadence /
  catch-up / anti-spam / pause-for-cap / depletion / range loss /
  persistence / two-miner atomicity / every resource type.
- `app/src/server/shard/sim.ts`: `SimLoop.tick()` is now `async` and runs
  `advanceMining(this.shard, this.hooks.repo ?? this.fallbackRepo, { nowMs })`
  on every step. `SimLoopHooks` gained optional `repo` + `fallbackRepo`.
  The mining advance is a **fast-path no-op** when no rows are active
  so legacy tests don't pay for it. `runOneStep()` defends against
  `drainInput` returning `undefined` (the legacy guard was `=== null` only).
- `app/src/server/shard/types.ts`: `ConnSender` union gained `mining_update`.
- `app/src/server/shard/index.ts`: `createShard({...})` accepts `repo`,
  threaded into the SimLoop.
- `app/src/server/ws.handlers.ts`: added `onMine` + `onMineStop`. They map
  rejection codes (`depleted` / `already-mining` → `invalid-message`,
  `wrong-regime` → `wrong-regime`, `not-found` → `not-found`,
  `out-of-range` → `out-of-range`) and push an initial / final
  `mining_update` echo.
- `app/src/server/ws.dispatch.ts`: `mine` + `mine_stop` frames routed
  in the `joined` case.
- `app/src/server/galaxy/router-load.ts`: `createShard` call threads
  `deps.repo` so mining persists on every shard.
- `app/src/server/galaxy/ws-router-bridge.ts`: connection-close hook
  drops any in-flight mining row for the disconnecting player.
- `app/src/server/ws.mining.test.ts` (NEW, 9 cases): full Fastify + WS
  round-trip covering range / depleted / mine_stop without active /
  cancel-when-mining-other / anti-spam / weight-cap pause / 5-unit
  depletion despawn / two-miner atomicity.
- `app/src/server/shard/sim.test.ts` + `combat.test.ts` +
  `disembark.test.ts` + `sim.character.test.ts` + `ws.reconnect.test.ts`:
  updated for the async `tick()` signature (`void await shard.sim.tick()`).

### Wire (`app/src/shared/protocol/`)

- `schemas.ts`: added `MineStopSchema` + `MiningUpdateSchema` to the
  registry. `InventoryUpdateSchema.action` enum gained `mine-progress`
  + `mine-paused-full`. `PAYLOAD_SCHEMAS` includes `mine_stop` and
  `mining_update`.
- `schemas.test.ts`: valid + invalid examples for the new schemas.

### Client (`app/src/client/`)

- `App.tsx`: wires `useMiningState(client)` + `<RadialMiningProgress>`,
  threads `onMineStart` / `onMineStop` through `<InteractionPrompt>`.
- `components/InteractionPrompt.tsx`: hold-E — `keydown` triggers
  `onMineStart(targetId)` when the prompt's action is `'mine'`,
  `keyup` triggers `onMineStop()`. Legacy tap dispatch unchanged for
  non-mining actions.
- `components/RadialMiningProgress.tsx` (NEW): CSS conic-gradient
  radial driven by `requestAnimationFrame` between server `mining_update`
  echoes. Spawns "+1 <resource>" float texts (1 s fade), surfaces
  "Backpack full" / "Depleted" / "Stopped (+N)" toasts.
- `components/useMiningState.ts` (NEW): subscribes to `onMiningUpdate`.
- `net/wsClient.ts`: `sendMine(nodeId, duration?)` + `sendMineStop()` +
  `onMiningUpdate(listener)`. Frame handler added in `handleMessage`.
- `index.html`: registers the `drift-mining-float` keyframe.

### E2E

- `tests/e2e/mining.spec.ts` (NEW): asserts `sendMine` / `sendMineStop` /
  `onMiningUpdate` are wired on the DriftClient test hook and saves a
  screenshot to `.ralph/screenshots/TASK-38-1.png`. Currently passes
  via `npm run dev` on port 3050 / 3051. Run command:

  ```
  PORT=3050 API_PORT=3051 npm run dev &
  cd app && npx playwright test tests/e2e/mining.spec.ts --reporter=line
  ```

## Working tree

- Uncommitted. `git status --short` shows 18 modified + 6 new files.
- `npx tsc --noEmit` is clean.
- `npx vitest run` passes 1771/1771 (stable across 3 consecutive runs).
- `npx vite build` produces the client bundle cleanly.
- `npx prettier --write` + `npx eslint --fix` clean on touched files
  (one pre-existing no-console warning in `combat.test.ts` is unrelated).
- Screenshot at `.ralph/screenshots/TASK-38-1.png` exists but is the
  *empty* radial (the e2e doesn't drive a real channel — only the
  wire layer is exercised). A mid-channel screenshot is the only
  remaining e2e gap.

## Next steps

1. **Commit everything** (see commit suggestion below). The uncommitted
   diff includes both the server and client work; it does NOT include
   any `passes: true` change. Keep `passes: false`.
2. **Capture a proper mid-channel screenshot.** The current e2e only
   verifies the wire layer; for visual proof drive a fake
   `mining_update` through the `__driftClient` test seam (or wait for
   the flight-assist harness so a real scripted walk-to-deposit can
   fire). Save to `.raldale-newscreenshots/TASK-38-{1,2}.png` (mid-channel
   + depleted state).
3. **Append a log entry** to `.ralph/logs/LOG.md` (newest-on-top,
   format used by TASK-37: heading with date + iteration, then the
   acceptance-criteria checklist from the spec verbatim). Do not set
   `passes: true` until you've done this.
4. **Decide what to do with the new `ws.mining.test.ts`'s `driveOnce`
   no-op placeholder** — currently `driveOnce` is a stub kept as a
   "future hook" hook. Either delete it or wire it up.
5. **Update `.ralph/STRUCTURE.md`** to list the new files:
   - `app/src/server/shard/mining.ts` (TASK-38)
   - `app/src/client/components/RadialMiningProgress.tsx` (TASK-38)
   - `app/src/client/components/useMiningState.ts` (TASK-38)
   - `tests/e2e/mining.spec.ts` (TASK-38)

### Commit suggestion

```
wip(TASK-38): server state machine + wire + client radial UI

Server: MINE_TICK_MS=1500 server-timed cadence, hold-E mine/mine_stop,
range/regime/depleted validation, anti-spam proof (spam=floor-allowed),
weight-cap pause, mid-channel despawn, two-miner atomicity.
Wire: mine/mine_stop/mining_update schemas + inventory_update action
gains mine-progress/mine-paused-full.
Client: RadialMiningProgress (conic-gradient, requestAnimationFrame
between server echoes), +1 resource float, hold-E prompt.
Tests: 20 server-side cases + 9 WS round-trip + 1 Playwright e2e.
1771/1771 unit + lint + tsc + build all green.
```

## Dead ends

- `addToInventory`'s `remaining` field is the **inventory overflow**
  (amount that didn't fit), NOT the source remaining. The deposit's
  new amount must be computed as `deposit.amount -= next.taken`, not
  `next.remaining`. First implementation broke the second test
  ("awards exactly 1 unit") because it set `deposit.amount =
  next.remaining` which was 0 — depleting the deposit on the very
  first award.
- `drainInput` can return `undefined`, not just `null`. The legacy
  `if (input === null) continue` check was a TypeError trap
  (`Cannot read properties of undefined (reading 'thrust')`). The
  guard is now `input === null || input === undefined`.
- The SimLoop's `lastTickReal = -1` prime-then-tick pattern is
  subtly hostile to test drivers. `tick()` once only consumes 0
  (returns early setting `lastTickReal`). Need TWO ticks for
  `fakeNow` to advance: prime (sets anchor), bump `fakeNow`, tick
  (now sees elapsed). The harness in `ws.mining.test.ts` uses a
  direct `advanceMining(shard, repo, { nowMs: fakeNow })` call to
  bypass the 5-step catch-up ceiling so a 7.5 s advance fires all
  five cadence awards in one call.
- The WS test's `shard.send` must be patched BEFORE
  `createShard` is called OR patched on both the stub shard AND
  `realShard` after the fact (the SimLoop holds a reference to
  `realShard` internally — patching only the stub leaves the mining
  tick writing to a black hole). Order in `ws.mining.test.ts`:
  define `realWriter` → set `shard.send = realWriter` → set
  `realShard.send = realWriter`. Done in this order the test works.
- The connection-close hook in `createConnectionCloseHook` reads
  the mining map from the shard — it needs `Shard` type imported
  (added to `ws-router-bridge.ts`).
- Don't trust `client.ws.readyState === conn.ws.OPEN` checks in
  tests without first sending a `setTimeout(20)` to yield to the
  event loop; the second frame sent back-to-back can be coalesced
  or arrive before the client's `message` listener drains the
  first. The `weight-cap` and `depletion` tests both needed an
  explicit `await new Promise(r => setTimeout(r, 20))` between
  `client.push(...)` and `waitFor(...)`.

## How to verify

```bash
cd /workspace/master/app

# TypeScript clean
npx tsc --noEmit

# All unit tests pass (currently 1771/1771)
npx vitest run

# Lint + format clean
npx prettier --check src/server/shard/mining.ts \
    src/server/shard/mining.test.ts \
    src/server/ws.mining.test.ts \
    src/client/components/RadialMiningProgress.tsx \
    src/client/components/useMiningState.ts \
    src/client/App.tsx \
    src/client/components/InteractionPrompt.tsx \
    src/client/net/wsClient.ts \
    src/shared/protocol/schemas.ts
npx eslint src/server/shard/mining.ts \
    src/server/shard/mining.test.ts \
    src/server/ws.mining.test.ts \
    src/client/components/RadialMiningProgress.tsx \
    src/client/components/useMiningState.ts

# Production build
npx vite build

# E2E
PORT=3050 API_PORT=3051 npm run dev &
sleep 5
npx playwright test tests/e2e/mining.spec.ts --reporter=line
# expect: 1 passed
kill %1
```

After all six checks pass, mark `.ralph/tasks.json` `TASK-38.passes = true`,
append the TASK-38 log entry (mirror the TASK-37 entry format), commit
the screenshot if you grab one, and output
`<promise>TASK-38:DONE</promise>`.