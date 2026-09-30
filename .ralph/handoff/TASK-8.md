# TASK-8 handoff — Inter-system warp with in-world transition

## Status
The full warp implementation (server + client) is COMPLETE and verified this session: all unit/WS suites pass, `tsc --noEmit` clean, eslint/prettier clean on touched files, and the real-browser e2e (`warp.spec.ts`) passed in 14.3 s with screenshots. This session ended before the final project-wide `npm run test` confirmation run, so `passes` was left `false` for handoff safety — flip it to `true` after one clean full-suite run.

## Done
Everything in the spec (`.ralph/tasks/TASK-8.json`) is implemented and tested:

- **Shared**
  - `app/src/shared/galaxy/spawn.ts` (NEW) — `SPAWN_GATE_POS` (100 u +X), `SPAWN_GATE_QUAT` (pure −90° yaw about Y: +Z → −X; module-load self-check), `spawnGatePose()`.
  - `app/src/shared/galaxy/system.ts` — `systemForId(seed, systemId)` (seeded scan, memoized per (seed, id), caches `undefined` for unknown ids).
  - `app/src/shared/protocol/schemas.ts` — `warp_arrived {systemId, snapshot}` type.
- **Server**
  - `app/src/server/shard/shard.ts` — `removePlayer(playerId)`: connection AND entity leave (warp departure; distinct from `leavePlayer` idle keep-alive).
  - `app/src/server/galaxy/router.ts` — `warp(from, target, player)`: seed-lookup validation + 16-cap with back-to-back `registerConnection` (no await between check and reserve), adopt + reposition at gate, ship row persisted (position.systemId = target, gate pose, 'flying') BEFORE `source.shard.removePlayer` + grace stamp. Rejection leaves player untouched.
  - `app/src/server/galaxy/gateway.ts` — `warpSystem` exposed.
  - `app/src/server/ws.ts` — `case 'warp'` (auth/join guards, same-system → `invalid-message`, error passthrough, mid-warp socket-close → `leaveSystem(target)` cleanup, presence leave/join to both peer sets, `warp_arrived`, `conn.systemId` update).
- **Client**
  - `app/src/client/state/warp.ts` — TASK-7 bus + phase store (`idle|warping-in|awaiting|warp-out`) + `WarpController` (2 s in → race request vs 10 s timeout → 2 s out → idle; `start()` busy-guard, `abort()`, injectable `delay`, 'System full' toast mapping).
  - `app/src/client/net/session.ts` — `warpTo(toSystemId)`: optimistic `lastSystemId` commit to target; `warp_arrived` → resolve + `onSnapshot(snapshot, false)`; error → `WarpRejectedError` + rollback to source; close-mid-warp rejection.
  - `app/src/client/world/WorldManager.ts` (NEW) — three.js scene on #game-canvas (camera (150,40,150) → origin); `swapWorld(system)` builds-then-replaces (no blank frame), returns measured ms (`WORLD_BUILD_BUDGET_MS = 300`); pure three-free `buildSystemLayout`.
  - `app/src/client/render/starfield.ts` — extracted `createBackground(seed)` shared by boot starfield + WorldManager.
  - `app/src/client/ui/warp-overlay.tsx` (NEW) — CSS streak overlay, phase-driven fades, `#game-canvas.warp-shake`.
  - `app/src/client/main.tsx` — world handover effect (boot starfield → WorldManager on first systemId; `swapWorld` + `reportWorldSwap` on every later change), WarpController on the warp bus, `<WarpOverlay>` mounted.
  - `app/src/client/ui/star-chart.tsx` — Warp button disabled for the whole transition; `presence.ts`/`toast-stack.tsx` — `notice` toast; `drift-debug.ts` — `worldSwap` for e2e.
- **Tests** (all green at commit time)
  - `app/src/server/galaxy/warp.ws.test.ts` (5): A→B (entity at gate, row follows, presence to both peer sets), same-system reject, unknown target, full-system (16 real conns) reject, mid-warp disconnect (exactly 1 entity before, exactly 1 after reconnect into row's system).
  - Units: `spawn.test.ts` (4), `systemForId` in `system.test.ts` (3), `world-manager.test.ts` (5), `warp-controller.test.ts` (6), `session.test.ts` warpTo describe (4), `schemas.test.ts` +`warp_arrived` fixture.
  - E2E `app/tests/e2e/warp.spec.ts`: disables/WARPING…, no-black-frame at t≈1 s (`canvasLuminanceVariance > 1`), duration 3–6 s, `__DRIFT__.worldSwap` = target && buildMs < 300, star at canvas center (new `canvasCenterLuminanceMean` in `helpers.ts`), `#sys-id` follows.
  - Screenshots: `.ralph/screenshots/TASK-8-{1,2,3}.png`.
- `.ralph/logs/LOG.md` entry + `.ralph/STRUCTURE.md` updated (commit `0b2ab21`).

## Working tree
- Clean except this handoff + the `passes` flip-back. Everything else is committed:
  - `98cc8f2` wip: initial untested implementation (previous session)
  - `204775f` test(TASK-8): SPAWN_GATE_QUAT yaw-axis fix (was rotating about X → +Z mapped to +Y, crashing the module-load self-check and 5 server suites), WS + unit suites, e2e spec
  - `0b2ab21` feat(TASK-8): final polish — this commit had set `passes: true`; this handoff reverts it to `false` until the full-suite confirmation
- Builds: `npx tsc --noEmit` in `app/` CLEAN at commit time. eslint + prettier clean on all touched files. No background processes running.
- NOT yet run after the final test-file edits: the full `npm run test` (every touched suite WAS run green: shared+server/galaxy 24 files/282 tests, client warp/session/world 106 tests, warp.ws 5/5) and the FULL `npm run test:e2e` (only `warp.spec.ts` ran, green — the other 5 specs were green before this task and this task touches no shared e2e behavior except an additive helper in `helpers.ts`).

## Next steps
1. `cd app && npm run test` — expect all green (~75 s).
2. `cd app && npm run test:e2e` — expect 6/6 (each spec ~10–25 s; ~2–3 min total).
3. Both green → set `"passes": true` for TASK-8 in `.ralph/tasks.json`, delete THIS handoff, commit. (LOG.md + STRUCTURE.md are already done.)
4. Optional sanity: the e2e duration assert (3–6 s) could flake on a very slow machine — if flaky, widen to 3–8 s rather than re-architecting.

## Dead ends
- `SPAWN_GATE_QUAT` first draft put the sin term on X (a −90° roll about X maps +Z to +Y, not −X) — the module-load self-check threw and broke 5 server suites at import. Fix: sin term on Y (yaw). Keep the self-check; it's what caught it.
- WS test: the ship row's `position.systemId` does NOT change on a plain join (it stays at the claim-time home system until a flush/warp) — assert "row unchanged" via before/after `toEqual`, never `toBe(SYS_A)`.
- WS mid-warp test: the warp frame can be LOST in the pipe (socket closes before the server reads it) — then the row stays at the source/home system, which may be a THIRD system (the claim's home, not SYS_A or SYS_B). The ghost loop must check `[SYS_A, SYS_B, homeSystemId]` minus the row's system; an idle ship in the source shard in that case is CORRECT, not a ghost.
- `WarpController` tests: with a single instant `delay`, the timeout arm's microtask queues before the request's and WINS every race (spurious 'timeout'). Use a delay that hangs for `ms >= WARP_AWAIT_TIMEOUT_MS` in happy/reject tests; use instant only in the timeout test.
- A `cat >> file <<'EOF'` heredoc via the shell tool silently did not append once (file unchanged, no error) — verify appends with `tail`; use the edit/write tools for file mutations.
- The e2e fixture runs the server with `SYSTEM_INSTANCE_COUNT: 1`, but the chart still shows 3 systems (overview endpoint is seed-derived) and warp lazily spawns the target shard via `router.getShard` — do not "fix" the fixture.

## How to verify
- `cd app && npx tsc --noEmit` → clean
- `cd app && npm run test` → all pass
- `cd app && npm run test:e2e` → 6/6 pass
- Manual: `npm run dev` in `app/`, open http://localhost:3000, claim, press M, select a node, click WARP — expect 2 s streak-in, world swap, 2 s streak-out, `sys <id>` line changes to the target.
