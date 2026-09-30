# TASK-8 handoff — Inter-system warp with in-world transition

## Status
Server-side warp flow (protocol, WS handler, router, shard) and the full client-side transition (state machine, world swap, CSS warp overlay, session wiring) are IMPLEMENTED and `tsc --noEmit` is clean. NOTHING is tested yet: no unit/e2e tests were written this session, no suite was run, and the client wiring has not been smoke-tested in a browser. The work is a working checkpoint, not a finished task.

## Done
All of the following is written but UNVERIFIED (no tests run, no browser run):

- **Shared**
  - `app/src/shared/galaxy/spawn.ts` (NEW) — `SPAWN_GATE_POS` (100 u +X), `SPAWN_GATE_QUAT` (forward +Z → −X, self-checked at module load), `spawnGatePose()`.
  - `app/src/shared/galaxy/system.ts` — added `systemForId(seed, systemId)` (scans seeded stars, memoized per (seed, id)); `generateStars` import added.
  - `app/src/shared/protocol/schemas.ts` — new `warp_arrived: {systemId, snapshot}` message type (server→client).
- **Server**
  - `app/src/server/shard/shard.ts` — new `removePlayer(playerId)`: removes connection AND entity (warp departure; distinct from `leavePlayer` which keeps the entity idle per TASK-17).
  - `app/src/server/galaxy/router.ts` — new `warp(fromSystemId, targetSystemId, player)` on `GalaxyRouter`: validates target (seed lookup) + 16-cap (check + `registerConnection` back-to-back, no await), adopts entity at target, repositions at gate (pos/vel/quat/regime/docked/idle/heldInput), writes the ship row via `repo.saveShipState` (position.systemId = target, gate pose, state 'flying'), THEN `source.shard.removePlayer` + `leave(from)` for the grace stamp. Returns `enterSnapshot(target)`. Added to the interface + returned object.
  - `app/src/server/galaxy/gateway.ts` — `warpSystem` exposed over the router.
  - `app/src/server/ws.ts` — `SystemGateway.warpSystem?` added; new `case 'warp'` in `handleMessage` (auth + joined-system checks, same-system rejected as invalid-message, error passthrough on rejection, mid-warp socket-close → `leaveSystem(target)` cleanup so the target shard can still reap, presence leave/join to both peer sets, sends `warp_arrived`, updates `conn.systemId`); `'warp'` removed from the `SYSTEM_SCOPED` default-branch set.
- **Client**
  - `app/src/client/state/warp.ts` (REWRITTEN, keeps the TASK-7 event-bus API: `warpSubscribe`/`dispatchWarpEvent`/`lastWarpEvent`/`__resetWarpState` — the 3 existing tests in `warp.test.ts` should still compile) — new `WarpEvent` member `warp-failed`, new phase store (`warpPhase()`/`warpPhaseSubscribe()`/`setWarpPhase()`), `WarpController` class (idle → warping-in 2 s → awaiting (races request vs 10 s timeout) → warp-out 2 s → idle; `start()` returns false when busy; `abort()`; injectable `delay` for tests; `onFailed` maps server "…is full…" messages to the toast text `System full`).
  - `app/src/client/net/session.ts` — `WarpRejectedError` (code+message), `warpTo(toSystemId): Promise<StateSnapshot>` (optimistically sets `lastSystemId` to the target so a mid-warp drop reconnects into the destination; server error rolls it back to the source), `warp_arrived` handling in `handleRaw` (resolves promise, `onSnapshot(snapshot, false)` → full-boot path), error-during-warp rollback, close-mid-warp rejection in `handleClose`.
  - `app/src/client/render/starfield.ts` — extracted `createBackground(seed, count)` (sky sphere + star points, `BackgroundHandle`); `createStarfield` now reuses it. Public API unchanged.
  - `app/src/client/world/WorldManager.ts` (NEW) — `WorldManager` class (owns renderer/scene on the canvas, camera at (150,40,150) looking at origin) with `swapWorld(system: SystemGen): number` (atomic build-then-replace, returns measured build ms; budget `WORLD_BUILD_BUDGET_MS = 300`), `currentSystemId`, `lastSwapMs`, `dispose()`. Pure `buildSystemLayout(system)` (star color by spectral class, first 2 planets at seeded orbit angles, gate at +100 u X) is three.js-free and unit-testable.
  - `app/src/client/ui/warp-overlay.tsx` (NEW) — CSS-only `#warp-overlay` (repeating-conic-gradient streaks + radial core, `mix-blend-mode: screen`), phase-driven fades (2 s in on `warping-in`, hold on `awaiting`, 2 s out on `warp-out`, unmount on idle) + `#game-canvas.warp-shake` CSS class during warp-in.
  - `app/src/client/net/presence.ts` — `PresenceToast.kind` += `'notice'` + optional `text`; new `store.notify(text)` for the `System full` toast.
  - `app/src/client/hud/toast-stack.tsx` — renders `notice` toasts verbatim.
  - `app/src/client/drift-debug.ts` — `DriftDebug.worldSwap` + `reportWorldSwap(systemId, buildMs)` (dev-only; the e2e asserts buildMs < 300 and the post-warp systemId through it).
  - `app/src/client/main.tsx` — server seed state (follows `/api/health`), world handover effect (first `systemId` disposes the boot starfield and creates the `WorldManager`; every subsequent `systemId` change — warp arrival — calls `swapWorld` + `reportWorldSwap`), `WarpController` wired to the warp bus (chart dispatches `warp-started`; controller sends the WS `warp` frame via `client.warpTo`), `<WarpOverlay />` mounted.
  - `app/src/client/ui/star-chart.tsx` — Warp button disabled while `warpingId !== null` (double-warp guard; label already showed WARPING…).

## Working tree
- Everything above is UNCOMMITTED except what this handoff commit captures (the commit below is a WIP checkpoint of the whole tree).
- Builds: `npx tsc --noEmit` in `app/` is CLEAN. `eslint`/`prettier` NOT yet run. NO tests have been run (unit or e2e). The existing `warp.test.ts` (3 bus tests) compiles but was not executed.
- Known open type/behavior details: none in tsc; runtime behavior of the new WS `warp` path is completely unexercised.

## Next steps
1. Run `cd app && npm run test` — expect the pre-existing suites to pass; fix anything the new schema/gateway changes broke (e.g. `schemas.test.ts` has per-type fixtures — add a `warp_arrived` case if that file enumerates types).
2. Write the WS integration test: `app/src/server/galaxy/warp.ws.test.ts` modeled on `reconnect.ws.test.ts` (in-process Fastify + `createGalaxyRouter` + `WsTestClient`; seeds via `generateStars`/`generateSystem`). Cases: (a) warp A→B → `warp_arrived` snapshot with own ship at (100,0,0), entity in B present / absent from A (check `router.active(SYS_X).shard.entities`), row `position.systemId === SYS_B`, presence leave to A peers + join to B peers; (b) target full (16 conns) → `error {code:'system-full'}`, player's entity still in A; (c) unknown target → `system-not-found`; (d) mid-warp disconnect: send warp, `client.close()` before/after arrival, then rejoin the row's `position.systemId` — exactly one own entity across both shards.
3. Write unit tests: `buildSystemLayout` determinism (pure, no three), `spawnGatePose` (+Z maps to −X via `quatRotateVector`), `systemForId` (found/unknown/memoized), `WarpController` flow with injected `delay` (happy path, double-start guard, `WarpRejectedError` → idle + onFailed('System full'), timeout → fail), `session.warpTo` with a scripted fake WebSocket (arrival resolves + onSnapshot; error rolls back lastSystemId).
4. E2E `app/tests/e2e/warp.spec.ts` (TASK-70 harness, `npm run test:e2e`): claim → open chart (M) → select first non-current node → screenshot `.agent/screenshots/TASK-8-1.png` → click `#warp-button` (assert it becomes disabled + `WARPING…`) → at t≈1 s assert `canvasLuminanceVariance` (helpers.ts) > 1 (no black frame) + screenshot `TASK-8-2.png` → wait for `#warp-overlay` to detach, assert total duration 3–6 s → wait for `__DRIFT__.worldSwap.systemId` === target && `buildMs` < 300 → center-of-canvas luminance check (star at center — add a small helper variant sampling one 32x32 region at canvas center) → screenshot `TASK-8-3.png` → `assertClean()`.
5. Playwright smoke of the real flow over `npm run dev` (vite :3000 proxy) if time allows.
6. `eslint --fix` + `prettier --write` on all touched files; full `npm run test` + `npm run test:e2e`; then set `passes: true`, LOG.md entry, STRUCTURE.md (new dirs `app/src/client/world/`, files listed above), commit.

## Dead ends
- A single fixed-duration CSS fade for the overlay cannot work: the network wait sits between the 2 s in and 2 s out fades, so the overlay is phase-driven (`warpPhaseSubscribe`) instead. An earlier draft of `warp-overlay.tsx` used a 4.2 s keyframe animation and would flash on unmount — already replaced.
- Ghost-entity edge analysis (documented for the test design): the client updates `lastSystemId` to the target optimistically when SENDING the warp, and the server cleans up the target slot if the socket died mid-warp (`leaveSystem(target)` in the ws.ts `warp` case). A warp frame lost entirely in the pipe (client disconnects before the server processes it) can leave the ship re-adopted in BOTH shards after a reconnect — accepted v1 edge, not worth a full server-side rollback; the WS test should assert "≤ 1 entity before reconnect, exactly 1 after reconnecting to the row's system".
- `SystemShard.removePlayer` (full removal) is intentionally separate from `leavePlayer` (idle keep-alive, TASK-17) — do not merge them.

## How to verify
- `cd app && npx tsc --noEmit` (clean as of this checkpoint)
- `cd app && npm run test` (not yet run)
- `cd app && npm run test:e2e` (new warp.spec.ts does not exist yet)
- Manual smoke: `npm run dev` in `app/`, open http://localhost:3000, claim a callsign, press M, select a node, click WARP — expect 2 s streak-in, system swap, 2 s streak-out, `sys <id>` line changes to the target.
