# Handoff: TASK-93.1

## Status

Spec-side work is COMPLETE and committed: the 3.5 m walk-land geometry fix is in
`app/tests/e2e/touch-onfoot.spec.ts` (committed `44de759`), `git diff app/src app/tests/e2e/fixtures.ts`
is EMPTY, `npx tsc --noEmit` is green, and a GREEN run (17:26 UTC) regenerated
`.ralph/screenshots/TASK-93-1.png` (on-foot touch layout + '[E] Enter ship' prompt).

**ROOT CAUSE OF THE FLAKE IS NOW IDENTIFIED** (this iteration, via a temporary first-line probe in
`generateSurfaceChunk` that captured the caller stack — probe reverted, tree clean):

- Full chain: `loop (main.tsx ~1653) → CharacterPredictor.step (character-prediction.ts) →
  integrateCharacter (character.ts) → characterSubstep → heightAt(pos.x, pos.z) →
  WorldManager.groundHeightAt → CharacterGround.heightAt → TerrainContext.update (terrain.ts:43) →
  generateSurfaceChunk(NaN, NaN) → RangeError at BigInt (noise.ts:52)`.
- The NaN is NOT in any position: static analysis proves `integrateCharacter` maps finite state →
  finite x/z (a NaN quat is the one exception, see below). The NaN is the PREDICTED QUAT:
  `quatSlerp` in `app/src/shared/physics/vec.ts:173-192` computes `Math.acos(dot)` at line 178
  WITHOUT clamping dot to [-1, 1]. For near-identical unit quats (the steady-state walking blend,
  where `dot ≈ 1.0`), float rounding pushes `dot > 1.0` by 1 ulp → `acos` = NaN → NaN quat.
  `CharacterPredictor.reconcile` (BLEND mode) stores it via `lerpState` → next walking substep:
  `quatRotateVector(NaN quat)` → zero-ish fwd → `vecNormalize` → NaN vel → NaN pos → `heightAt(NaN)`
  → `BigInt(NaN)` throws. The poisoned state persists (every `step()` throws before reassignment),
  until the next 10 Hz reconcile lands in REWIND mode (`correctionAngle` is NaN → not < threshold)
  and replaces the state with clean server data → burst ends. This explains EVERY observation:
  pos/vel/rot probes all finite (the NaN lives only in the predicted quat, and throwing frames never
  reach the post-step probe in main.tsx ~1690); bursts of 12-27 pageerrors ≈ 200-450 ms ≈ one
  snapshot interval; bursts correlate with walking (blend mode is exactly when predicted/server quats
  are CLOSE, i.e. `dot ≈ 1`, i.e. the rounding-risk maximum); `enter-ship.spec.ts` fails identically
  (same on-foot walking → same blend path) with `git diff app/src` empty.
  NOTE: `quatAngleBetween` (vec.ts:160-163) ALREADY clamps dot the same way — the clamp was missed
  in `quatSlerp`. One-line product fix: `Math.acos(Math.min(1, Math.max(-1, dot)))` at vec.ts:178
  (out of TASK-93.1 scope — spec-side only; recorded here + commit message, split to a product task).

Prior session's run stats (post-fix HEAD): 1 green / 4 red — all 4 reds are the identical NaN-BigInt
flake (13-18 pageerrors each). Flake rate ~80%, WORSE than the 40-60% measured earlier.

**DECIDE ANSWERED (decisions.jsonl, 2026-10-09T21:56Z): OPTION A** — split the flake into its own
product task and gate TASK-93.1's `assertClean` on it. **EXECUTED in this iteration:**
`.ralph/tasks/TASK-96.json` created (red-first regression test + the dot clamp + a
`CharacterPredictor.reconcile` finiteness guard + enter-ship e2e smoke), inserted BEFORE TASK-93.1
in `.ralph/tasks.json` so the loop (first `passes: false`) picks TASK-96 first; TASK-93.1 steps 1-2
marked pass, step 3 / `passes` stay false (gated on TASK-96).

## Done

Committed: `7cf56bf` (step-1 implementation), `8eb9320` (leg-4 steering rewrite), `1f2d428` (the
split), `44de759` (this task's 3.5 m walk-land spec fix), `9a2d7dc` (root cause recorded + green-run
screenshot committed).

This iteration (on top of `9a2d7dc`, executing DECIDE Option A):
- Created the product task `.ralph/tasks/TASK-96.json` (regression test red-first: `quatSlerp` of
  near-identical unit quats with dot rounding > 1 must be finite — reproduced numerically: dot =
  1.0000000001 → all-NaN under the current formula; the dot clamp at vec.ts:178; a finiteness guard
  in the predictor's BLEND reconcile + unit test; enter-ship e2e smoke) and registered it in
  `.ralph/tasks.json` BEFORE TASK-93.1 (loop picks first `passes: false`).
- Marked TASK-93.1 steps 1 (diagnosis — done, root cause) and 2 (spec-side geometry fix — done,
  green run 17:26 UTC) as pass; step 3 / `passes` left false, GATED on TASK-96 landing.
- LOG.md entry + this handoff updated. Verified: `git diff app/src app/tests/e2e/fixtures.ts` EMPTY,
  `npx tsc --noEmit` GREEN, no product code touched (spec-side AC 3).

## Working tree

- Committed (do NOT redo): everything above; the spec fix IS committed (44de759), the root cause +
  screenshot in 9a2d7dc, and THIS ITERATION'S bookkeeping (TASK-96.json + tasks.json + this spec +
  LOG.md + this handoff) in this iteration's commit.
- Pre-existing dirty files NOT mine — do NOT commit: `.gitignore`, `.ralph/prd/PRD.md`,
  `ralph.config.json`, `.ralph/decisions.jsonl`, ~50 modified `.ralph/screenshots/*.png` (NOT
  TASK-93-1.png), `?? .gitattributes`, `?? .ralph/ESCALATION.md`, `?? .ralph/logs/t761/`,
  `?? .ralph/logs/t83/`, `?? .ralph/tasks/TASK-89..95.json` (the untracked ralph-generated specs —
  NOT mine; TASK-96.json IS mine and committed), `?? app/.ralph/`, `?? app/.trace-tmp/`.
- Build state: `npx tsc --noEmit` green; product code unchanged (no product changes in this task).

## Next steps

1. **Next iteration should be TASK-96** (the loop picks it — it is now first `passes: false` in
   tasks.json). Implement per `.ralph/tasks/TASK-96.json`: regression test red-first, the one-line
   dot clamp in `quatSlerp` (vec.ts:178), the `CharacterPredictor.reconcile` BLEND finiteness guard
   + unit test, tsc + full unit suite green, enter-ship.spec.ts e2e smoke with zero NaN-BigInt
   pageerrors, commit only the task files.
2. **AFTER TASK-96 lands, this task resumes (it stays `passes: false` until then):** re-run
   `cd app && npx playwright test touch-onfoot.spec.ts --config playwright.e2e.config.ts
   --reporter=line` (2-4 min/run) to FULL green — all 4 legs + `assertClean`, zero pageerrors; the
   green run regenerates `.ralph/screenshots/TASK-93-1.png` (verify it). Then: mark TASK-93.1 step 3
   pass + `passes: true` in `.ralph/tasks.json`, LOG.md entry, **DELETE this handoff**, and commit
   `wip(TASK-93.1): touch-onfoot e2e fully green — NaN-BigInt flake fixed by TASK-96` per the spec's
   step 3 (exclude every pre-existing dirty file).
3. TASK-93.2 then owns the final TASK-93 close-out + regression gate.
4. Do NOT re-probe the same points (exhausted, see Dead ends). Do NOT touch product code in THIS
   task (spec-side only — AC 3); the product fix is TASK-96's scope.

## Dead ends

- **Nudging toward the signed bearing** (`dir = angle > 0 ? 1 : -1`): ping-pongs forever (the flip
  to `dir = angle > 0 ? -1 : 1` is in 8eb9320 and must be kept).
- **Burst-length control of turn amount**: a 100 ms yaw burst turns ~70-90° on this software-GL page
  (release event queued 400-600 ms late) — keep the 0.79 rad walk-band + 100 ms nudge design.
- **Server-side console probing**: the e2e fixture swallows server stdio (`bootServer` in
  app/tests/e2e/fixtures.ts) — use the client `__CHAR__` hook instead.
- **2.5 m walk-land sizing**: lets the release coast + late yaw tail carry the character PAST the
  ship (measured 0.37 m overshoot) — fixed to 3.5 m (committed); the flake persisted because it is
  the quatSlerp product bug, not the geometry.
- **Assuming a non-finite predicted/server POSITION feeds the NaN chunk**: EXHAUSTIVELY ruled out —
  st.pos/vel, wire pos/vel/rot, __CHAR__.pos, terrain feed, CharacterGround.heightAt inputs,
  active-chunk scheduling, and (this session) predictor pos/vel at step start AND after reconcile
  were ALL finite in failing runs. The non-finite field is the predicted QUAT (root cause above).
  Do not re-probe positions; the chain is closed.

## How to verify

Per TASK-93.1 ACs: `touch-onfoot.spec.ts` fully green (all 4 legs AND `assertClean` — achieved in the
17:26 green run, but FLAKY ~80% until TASK-96's product fix lands; step 3 is GATED on it);
`.ralph/screenshots/TASK-93-1.png` regenerated by the green run (committed in 9a2d7dc, on-foot touch
layout + '[E] Enter ship' prompt); `git diff app/src app/tests/e2e/fixtures.ts` empty (spec-side
only; the latent product bug is now TASK-96, not fixed here); no temporary probes; `npx tsc --noEmit`
green; task files committed. THIS ITERATION'S verification: TASK-96 spec created + registered first
in tasks.json; 93.1 steps 1-2 pass / step 3 gated; LOG.md updated; tree clean of product changes.
