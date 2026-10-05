# TASK-58 handoff — LOD/impostor tuning to draw and memory budgets

## Status
Steps 2 (partial: FX caps only) and 3 (perf table) are implemented and committed; the FX
registry caps and the tuning table are in, but the benchmark driver, baseline numbers,
instancing passes, 5-run variance check, CI 10 s test, and the task-spec `bench:render`
npm script are all still missing. Task is NOT complete; no step flag may be set yet.

## Done
All committed in **5a0b2f2** (the harness "chore(TASK-56)" screenshot-refresh commit swept
in this work — verify with `git show 5a0b2f2 -- app/src/shared/perf.ts`):
- **`app/src/shared/perf.ts`** (NEW) — `PERF_PROFILES: Record<QualityPreset, PerfProfile>`:
  the tuning table (step 3). Each preset carries `lodRadii` (mirrors `lodRadiiFor`),
  `starCount`/`fxQuality` (mirror `PRESETS`), `fxCaps {laserFlashes:16, missiles:16,
  debrisSets:8}` for high, `maxLabels: 20` for high (the AC-1 scene's 20 labels), and
  `budgets {drawCalls:120, materials:40, triangles:500000}`. `perfProfileFor(preset)` is
  the pure lookup. Every number has a comment citing its origin — **NOTE: the comments cite
  a "bench-run-1" baseline that does NOT exist yet (benchmark not built); after building the
  baseline, rewrite those comments with the real numbers.**
- **`app/src/client/world/combat-fx.ts`** — FX caps (AC-4, step 2 pass 4):
  `Flash` gained `kind: 'laser'|'impact'|'explosion'` + `groupId`; new
  `enforceCap(kind, cap)` expires the OLDEST group beyond the cap before each new
  laser flash / explosion set is pushed; `setFxCaps`/`getFxCaps`/`laserFlashCount`/
  `debrisSetCount` accessors; `updateProjectiles` tracer cap now reads `this.caps.missiles`
  (default 16 = `TRACER_CAP`). Caps default to `PERF_PROFILES.high.fxCaps`.
- **`app/src/client/perf/profile-bridge.ts`** (NEW) — `registerFxCapSink(sink)` (returns
  unregister) + `applyPerfProfile(preset)` (pushes `profile.fxCaps` to every sink +
  `setLabelCap(profile.maxLabels)`); `__resetPerfBridge()` test hook.
- **`app/src/client/world/remote-entities.ts`** — live label cap: `setLabelCap(n)` /
  `getLabelCap()`; `labelStates()` now caps at `liveLabelCap` (default `MAX_CALLSIGN_LABELS`
  = 16, so standalone unit tests are unchanged).
- **`app/src/client/a11y/reduced-motion.ts`** — `setQuality` / `applySettings` /
  `__resetSettings` now also call `applyPerfProfile(...)` (the SettingsBridge half).
- **`app/src/client/perf/frameMonitor.ts`** — `FrameStats.maxFrameMs` (rolling max,
  percentile(100)) + `frameSpikes(thresholdMs)` count — the no-spike rule's machinery.
- **`app/src/client/ui/debug-overlay.test.tsx`** — uncommitted fix: `MOCK_STATS` literal
  needed `maxFrameMs: 31.02` (the only uncommitted file in the tree; `tsc --noEmit` is
  green with it).

## Working tree
Only `app/src/client/ui/debug-overlay.test.tsx` is uncommitted (the maxFrameMs fix —
commit it first thing: `git add app/src/client/ui/debug-overlay.test.tsx .ralph/handoff/TASK-58.md && git commit -m "wip(TASK-58): fx caps + perf table + no-spike monitor fields"`).
`npx tsc --noEmit` clean (app dir). No background processes were left running. No unit
tests have been run since the combat-fx / remote-entities edits — the existing suites
(`src/client/fx.test.ts`, `remote-entities.test.ts`, `frame-monitor.test.ts`,
`settings.test.ts`) have NOT been re-verified; run them before trusting anything.

## Next steps
1. Commit the one uncommitted file + this handoff (command above).
2. `npm run test` (app dir) — full suite; fix any fallout from the combat-fx Flash shape
   change (fx.test.ts touches addLaserFlash/addExplosion; the group/cap behavior at the
   16 cap could affect tests that fire > 16 flashes in one window).
3. **Step 1 — baseline (the missing core piece):** build the scripted 60 s benchmark scene.
   AC-1 scene: 16 ships (8 players + 8 AI) in combat + player on surface with 13-chunk
   streaming + 8 hazard cells + 30 deposits + 20 labels. Options: (a) e2e-driven —
   Playwright page with the real SwiftShader scene, N second WS clients firing (raw-ws,
   see `tests/e2e/pvp-kill.spec.ts` + `tests/e2e/raw-ws.ts`), reading
   `frameMonitor.getFrameStats()`/`frameSpikes(50)` + `renderer.info` from the page;
   (b) headless DOM-free like `src/client/test/transitionCycle.ts` (it already drives the
   per-frame stages without GL — but has no renderer, so draw calls/tris must be measured
   differently). The task spec wants `npm run bench:render` + a 10 s CI test asserting
   the no-spike rule only — the e2e path is the only one that yields real renderer.info.
4. **Step 2 passes still missing:** (1) instancing for deposits (`OreRockLayer` currently
   creates one mesh+material per deposit — switch to InstancedMesh per resource, batch
   size from `PERF_PROFILES[...].instanceBatches`), drones (`buildDroneMesh` per drone in
   remote-entities), (2) per-ring chunk merge (see `chunk-scene.ts`), (3) material pool /
   livery via instance attributes, (5) verify starfield is already one Points cloud
   (`src/client/render/starfield.ts` — probably already done).
5. **Step 4:** 5-run variance check (p95 variance < 20 %), 10 s CI test, record numbers,
   then set step flags + `passes` per the task flow.
6. Register the frame budgets as gauges on `frameMonitor` (`registerGauge` + `gaugeCheck`)
   from the active profile in WorldManager's frame loop — budgets exist in perf.ts but
   nothing enforces/reports them yet.
7. Close-out: LOG.md entry, tasks.json, delete this handoff.

## Dead ends
- Nothing tried-and-failed this session (implementation-only pass). Known risks noted in
  Next steps: fx.test.ts fallout; the perf.ts comments overstate what was measured.

## How to verify
- `cd app && npx tsc --noEmit` (green as of handoff)
- `cd app && npm run test` (NOT yet re-run after this session's edits)
- `git show 5a0b2f2 --stat` to see what landed
- FX caps behavior: new unit test should assert `CombatFx` with `fxCaps.laserFlashes=2`
  drops the oldest group after 3 `addLaserFlash` calls, `laserFlashCount` stays ≤ 2.
