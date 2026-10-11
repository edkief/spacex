# TASK-99 handoff — Touch flight analog: joystick magnitude reaches the wire payload (client-only)

## Status
Implementation is COMPLETE and the primary gate is green (unit + typecheck + touch-flight e2e all pass, measured analog ratios in band). The only remaining gate is `touch-loop.spec.ts` (SC-1 regression), which failed 3/3 runs this session on two DIFFERENT legs (land glide, then re-enter ×2) — both are pre-existing flake families, and the failure spot moving between runs argues flake over regression; it needs 1–2 clean runs (or a pre-change baseline run) before close-out.

## Done
All product + test code landed (uncommitted, see Working tree):

1. **`app/src/client/input/touch.ts`** — three new exports + imports + module-header note:
   - `mergeAxis(kb, touch): number` — larger |value| wins; equal magnitude (incl. both-zero and equal opposition) → keyboard.
   - `touchFlightAxes(scheme, channels)` — projects the touch axes into PHYSICS convention at ANALOG magnitude: thrust +c, yaw −c (TASK-80 negation, parity with key 'd'), pitch −c (nose-up = physics-negative, parity with 'f'), roll +c (parity with 'e'); a scheme with a NULL flight axis (surface) projects to all zeros; `flip` guard against −0 (same canonical-zero rule as `readSchemeInput`).
   - `mergeFlightInput(kbInput, touchChannels, scheme): ShipInput` — merges the four axes via `mergeAxis`; `up`/`boost` pass through the keyboard readout (button-driven, binary).
2. **`app/src/client/main.tsx`** (~line 1851, ship-loop `body`) — after `effectiveFlightPressed`, the loop now builds TWO readouts of the SAME scheme (`dockedFlightScheme(regime)` when docked/surface, else `regimeWiring.remapper.scheme`):
   - axis readout from the **keyboard-only set** `effectiveFlightPressed(pressedRef.current, {chartOpen})` — CRITICAL: the touch sticks' own virtual keys ('w'/'s'/…) in the merged set read as ±1 there and `mergeAxis` would let that binary 1 beat the stick's 0.5 (first e2e run failed with ratio exactly 1.0 for this reason — the merged-set readout is the bug);
   - `up`/`boost` from the **merged-set readout** (touch VTOL/BOOST buttons write ' '/'Shift' virtual keys and must still register);
   - result: `scaleLookDemand({...mergeFlightInput(kbInput, touchRef.current.snapshot(), scheme), up: withButtons.up, boost: withButtons.boost}, sensitivity)` → the existing `shipInputToPayload`/`p.step` untouched.
3. **`app/src/client/input/flight-analog.test.ts`** (NEW) — 15 unit tests: mergeAxis sign/abs/tie; touchFlightAxes ±1 sign parity with `readSchemeInput` for all 8 key/channel cases + analog magnitude + no −0 + surface-scheme zeros; mergeFlightInput keyboard-only deep-equals legacy readout for space/atmosphere/surface schemes (the regression guarantee); payload byte-for-byte legacy with no touch channels; payload carries analog magnitudes (thrust=0.5 → 0.5, kb-wins, touch-wins cases). All 15 green.
4. **`app/tests/e2e/touch-flight.spec.ts`** — renumbered legs, added:
   - (4) ANALOG THRUST: deep-space teleport → thrust=0.5 × 2 s vs thrust=1.0 × 2 s → server-speed ratio in [0.45, 0.55] + screenshot `.ralph/screenshots/TASK-99-1.png` (80 KB, written by the green run — take a look: touch flight layout over deep space).
   - (5) ANALOG YAW: from rest, yaw=1.0 × 1 s vs yaw=0.5 × 1 s, each probed against its OWN start orientation (`initialRight` of the pre-run quat) → dot-ratio in [0.4, 0.6] (scout turnRate 0.8 rad/s → sin(0.4)/sin(0.8) ≈ 0.54; 2 s runs would saturate the dot and flatten the ratio, so 1 s).
   - console.log now includes `analog: v-half=… v-full=… ratio=… yaw-dot full=… half=… ratio=…`.

## Working tree
**Nothing committed yet.** Uncommitted task files (commit these, exclude everything else — the tree has many pre-existing dirty files: old screenshots, `.gitignore`, `.ralph/prd/PRD.md`, `.ralph/tasks.json`, `ralph.config.json`, untracked TASK-89..92/98/99/100..102 json, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `.gitattributes`, `.ralph/ESCALATION.md`, `app/.ralph/`, `app/.trace-tmp/`):
- `app/src/client/input/touch.ts` (M)
- `app/src/client/input/flight-analog.test.ts` (NEW)
- `app/src/client/main.tsx` (M)
- `app/tests/e2e/touch-flight.spec.ts` (M)
- `.ralph/screenshots/TASK-99-1.png` (NEW)

Builds: `npx tsc --noEmit` GREEN (run 23:46 after the final edit). eslint --fix + prettier --write already run on all four files.

## Next steps
1. **The one remaining gate:** `cd app && npx playwright test tests/e2e/touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line` (single-batch invocation is the documented shape; 3 min timeout). Needs a clean run. If it stays red, establish a baseline: `git stash push` the four task files (or checkout `64e5fe7` into a worktree) and run the same spec there — if the baseline also flakes, the failures are pre-existing and a few more runs should eventually go green (the log's TASK-95.1 entry records the same land/re-enter flake families).
2. If green: re-run the full unit gate once (`cd app && npm run test`, ~3 min — expect the documented abuse.spec.ts / multiplayer-foot p95 wall-clock flake family; any red file green in isolation is acceptable per LOG.md precedent) and `npx tsc --noEmit`.
3. Close-out bookkeeping: `.ralph/tasks/TASK-99.json` has plain-string steps (no pass flags to flip); set `"passes": true` for TASK-99 in `.ralph/tasks.json`; LOG.md entry at top (date 2026-10-10/11, summary incl. measured ratios below + screenshot path + the merged-set-vs-keyboard-only axis fix as the notable root cause); bump LOG.md 'Tasks Completed' 116 → 117 and 'Current Task' line; delete this handoff; STRUCTURE.md unchanged (no new dirs).
4. Commit: Conventional Commit, e.g. `feat(TASK-99): analog touch flight magnitudes reach the wire payload` (the four files + screenshot + bookkeeping + handoff deletion).
5. Output `<promise>TASK-99:DONE</promise>` and STOP.

## Dead ends
- **Merged-set axis readout is the trap:** first implementation read `readSchemeInput(scheme, pressed)` (the merged keyboard+touch set) — the sticks' virtual keys ('w' for thrust=0.5) made the keyboard readout ±1, and the e2e ratio came out exactly **1.000** (assert failed: `Expected: <= 0.55, Received: 1`). Fix: axis readout from `pressedRef.current` (keyboard-only) with the chartOpen guard; buttons from the merged set. Do not "simplify" this back to one readout.
- `touchFlightAxes` initially leaked **−0** through `-(v ?? 0)` for absent channels — toEqual distinguishes −0/+0; fixed with the `flip` canonical-zero guard (the `readSchemeInput` precedent).
- The e2e yaw leg spec text suggested 2 s runs like thrust; 2 s at 0.8 rad/s = 1.6 rad → sin ≈ 1 saturates and kills the ratio — runs are 1 s each with per-run start-orientation probes.
- `touch-loop.spec.ts` failures (3 runs this session): run 1 land leg `still 87 m from the pad after 3 glides`; run 2 re-enter leg `expect(locator).toBeHidden() failed — Locator: #interact-prompt … 22 × visible`; run 3 same re-enter leg (land leg itself DOCKED dist=0.3 m). The diff cannot affect those legs deterministically: on-foot legs run with `shipPredictorRef.current === null` (loop body early-returns), the land glide is dead-stick (channels cleared → merge is a no-op), and the VTOL touchdown button path is byte-preserved (proven: touch-flight leg 8 green, vtol vel.y=10.5). Treat as the documented flake family, verify with a baseline run if it persists.

## How to verify
- Unit: `cd app && npx vitest run src/client/input/flight-analog.test.ts src/client/input/touch.test.ts` → 30/30.
- Typecheck: `cd app && npx tsc --noEmit`.
- Analog e2e (measured GREEN this session, 54.1 s): `cd app && npx playwright test tests/e2e/touch-flight.spec.ts --config playwright.e2e.config.ts --reporter=line` → console: `analog: v-half=41.0 v-full=88.0 u/s ratio=0.466 yaw-dot full=0.850 half=0.439 ratio=0.516` (bands [0.45,0.55] / [0.4,0.6]), all 8 legs pass, `assertClean()` passes, screenshot `.ralph/screenshots/TASK-99-1.png`.
- SC-1 regression: `npx playwright test tests/e2e/touch-loop.spec.ts --config playwright.e2e.config.ts` — PENDING (see Next steps).
- Screenshot to look at: `.ralph/screenshots/TASK-99-1.png` (touch flight layout, deep space, mid half-thrust run).
