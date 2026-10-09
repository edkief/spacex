# Handoff: TASK-93.1

## Status

Spec-side steering is fixed and committed-ready: the 3.5 m walk-land geometry (per the split task's
prescribed fix) is in `app/tests/e2e/touch-onfoot.spec.ts`, all 4 legs + re-enter pass in green runs,
and `git diff app/src app/tests/e2e/fixtures.ts` is EMPTY. The remaining blocker is a PRE-EXISTING
product flake — `RangeError: The number NaN cannot be converted to a BigInt` pageerrors from terrain
chunk generation — which this iteration PROVED is not specific to this spec: `enter-ship.spec.ts`
(unmodified by this task) fails with the identical errors on this HEAD. The spec passes ~50-60% of
runs; `collectErrors().assertClean()` fails the rest.

## Done

This iteration (on top of committed 8eb9320):
- **Baseline reproduced**: legs 1-3 pass, leg-4 loop converges (probed: 11.5-11.9 → ~6.8 →
  ~3.0-3.5 m → '[E] Enter ship' in 6-9 passes), console logs `re-entered=ok` — the ONLY failure is
  `assertClean()` listing 14-49 NaN-BigInt pageerrors (stack: `BigInt ← latticeValue
  (src/shared/galaxy/noise.ts:52) ← valueNoise ← fbm01 ← generateSurfaceChunk
  (src/shared/galaxy/surface.ts:259)`).
- **Pre-existing flake CONFIRMED** (step 1b): `npx playwright test enter-ship.spec.ts walk.spec.ts`
  → walk passed; enter-ship failed with the same NaN-BigInt pageerrors (49 in one run, plus one
  failure in a paired run). This task's diff cannot affect enter-ship (product code untouched, only
  the touch-onfoot spec changed), so the flake is generic on-foot walking near the docked ship.
- **Exhaustive diagnosis (step 1a) — every probe came back FINITE in failing runs**:
  (a) `__CHAR__.pos` (server-authoritative) per leg-4 pass — finite, y constant 256 (pad plane);
  (b) predicted `st.pos` AND `st.vel` AND `st.quat` in the on-foot prediction loop (main.tsx ~1690)
  — finite;
  (c) wire character from the 10 Hz server snapshot (pos/vel/rot, main.tsx ~998) — finite;
  (d) terrain feed (feed x/y/z + speed) in `WorldManager.updateTerrain` (~line 810) — finite;
  (e) `CharacterGround.heightAt` inputs — finite;
  (f) active-chunk scheduling in `ChunkStreamer.update` — no non-finite chunk coords.
  → The NaN chunk coordinate enters `generateSurfaceChunk` through NO observed feed point. The flake
  bursts correlate with leg-4 WALK bursts (1-3 bursts per failing run, ~12-27 errors each).
- **Spec-side fix applied** (step 2, as prescribed): leg-4 hidden-aligned walk burst now lands
  ~3.5 m out (`((dist - 3.5) / 3) * 1000`, was 2.5 m) — stays in the 3-5 m '[E] Open cargo' zone so
  the prompt branch does the final 1.8 m approach. This removed the measured 0.37 m overshoot-past-
  the-ship case (2.5 m sizing let the release coast + late yaw tail carry the character THROUGH the
  ship's position). Result: 3 of 5 post-fix runs green (the 2 failures were the same pre-existing
  NaN flake). All probes removed afterwards.
- **Tree verified clean**: `git diff app/src app/tests/e2e/fixtures.ts` empty; spec diff is only the
  geometry fix (2 comment lines + 1 timeout constant); `npx tsc --noEmit` green.

## Working tree

- Committed (do NOT redo): `7cf56bf` = step-1 implementation; `8eb9320` = leg-4 steering rewrite
  (nudge-sign flip + walk bursts, converging); `1f2d428` = the split.
- Uncommitted (mine, my ONLY change): `app/tests/e2e/touch-onfoot.spec.ts` — the 3.5 m walk-land
  fix, clean code, no probes/listeners/logs.
- Untracked: `.ralph/screenshots/TASK-93-1.png` — rewritten by this iteration's GREEN probe runs
  (valid on-foot layout + '[E] Enter ship' prompt); the final green run should rewrite it again.
- Pre-existing dirty files NOT mine — do NOT commit: `.gitignore`, `.ralph/prd/PRD.md`,
  `ralph.config.json`, ~50 modified `.ralph/screenshots/*.png` (NOT TASK-93-1.png),
  `?? .gitattributes`, `?? .ralph/ESCALATION.md`, `?? .ralph/logs/t761/`, `?? .ralph/logs/t83/`,
  `?? .ralph/tasks/TASK-89..95.json`, `?? app/.ralph/`.
- Build state: `npx tsc --noEmit` green; product code identical to 8eb9320.

## Next steps

1. Re-run the spec 2-3×: `cd app && npx playwright test touch-onfoot.spec.ts --config
   playwright.e2e.config.ts --reporter=line` (~1-1.5 min each). If green: verify the screenshot was
   rewritten, `eslint --fix` + `prettier --write` on the spec, `npx tsc --noEmit`, `npm run test`
   (unit), then commit ONLY the spec + screenshot:
   `wip(TASK-93.1): touch-onfoot e2e green — leg-4 walk-land 3.5 m (spec-side); NaN-BigInt
   terrain flake recorded as pre-existing product bug (enter-ship.spec.ts hits it too)`.
2. If the flake recurs at a meaningful rate, the geometry is already optimized per the split task —
   the remaining work is a DECISION, not more spec geometry. Escalate DECIDE with this evidence:
   the NaN-BigInt pageerror is a pre-existing product bug (proven: enter-ship.spec.ts — untouched by
   this task — fails identically on this HEAD with `git diff app/src` empty), and the split task says
   to record product bugs in the commit message, not fix them. Options: (A) split the NaN-BigInt
   terrain bug into its own product task and let TASK-93.1's assertClean gate it (task not closable
   until the product fix lands), vs (B) treat enter-ship.spec.ts as the flake's canonical victim and
   close TASK-93.1 on spec-side green-in-N-runs + the recorded bug, accepting the shared flake.
3. If more diagnosis is wanted before deciding: the ONE un-probed boundary is
   `generateSurfaceChunk` itself. Add a temporary first-line guard in
   `app/src/shared/galaxy/surface.ts` (~line 246): `if (!Number.isFinite(chunkX) ||
   !Number.isFinite(chunkZ)) console.warn('[T93] genChunk', chunkX, chunkZ, new Error().stack)`
   (revert before commit) — it identifies the caller (the only client callers:
   `TerrainContext.update/cellHeight` in `app/src/server/shard/terrain.ts` lines 56/91 via
   `CharacterGround.heightAt`, and deterministic `padsForSystem` in `shared/world/pads.ts`).
   Everything UPSTREAM of both paths was probed finite, so the captured stack is the missing piece.
   Note: `ChunkBuild` (the streamer's per-chunk builder, chunk-geometry.ts:177) samples `fbm01`
   DIRECTLY, not via generateSurfaceChunk — a stack through generateSurfaceChunk rules it out.
4. Bookkeeping when green: step flags + `passes: true` in `.ralph/tasks.json`, LOG.md entry,
   delete this handoff (TASK-93.2 owns the final TASK-93 close-out).

## Dead ends

- **Nudging toward the signed bearing** (`dir = angle > 0 ? 1 : -1`): ping-pongs forever (from the
  TASK-93 handoff — the flip to `dir = angle > 0 ? -1 : 1` is in 8eb9320 and must be kept).
- **Burst-length control of turn amount**: a 100 ms yaw burst turns ~70-90° on this software-GL
  page (release event queued 400-600 ms late) — keep the 0.79 rad walk-band + 100 ms nudge design.
- **Server-side console probing**: the e2e fixture swallows server stdio (`bootServer` in
  app/tests/e2e/fixtures.ts) — use the client `__CHAR__` hook instead.
- **2.5 m walk-land sizing**: lets the release coast + late yaw tail carry the character PAST the
  ship (measured 0.37 m overshoot in one probed run) — that path triggered the NaN bursts. Fixed to
  3.5 m, but the flake persists because it is pre-existing (enter-ship.spec.ts reproduces it).
- **Assuming a non-finite predicted/server position feeds the streamer**: EXHAUSTIVELY ruled out —
  st.pos/vel/quat, wire pos/vel/rot, __CHAR__.pos, terrain feed, CharacterGround.heightAt inputs,
  and active-chunk scheduling were ALL finite in failing runs. Do not re-probe the same points;
  probe generateSurfaceChunk itself (next step 3).

## How to verify

Per TASK-93.1 ACs: `touch-onfoot.spec.ts` fully green (all 4 legs AND `assertClean` — zero
console/page errors); `.ralph/screenshots/TASK-93-1.png` regenerated by the green run (on-foot touch
layout + '[E] Enter ship' prompt); `git diff app/src app/tests/e2e/fixtures.ts` empty (spec-side
only, latent product bug recorded in commit message not fixed); no temporary probes;
`npx tsc --noEmit` green; one commit with only the task files.
