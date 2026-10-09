# Handoff: TASK-93

## Status

Step 1 (implementation) is complete, committed (`7cf56bf`), unit-verified. E2e legs 1–3 are
green; leg 4 (re-enter) was reworked THIS session: the steering loop now converges
(dist 11.39 → 6.54 → 2.98 m in 4 passes) after a **nudge-sign flip**, but the run then hit a
new blocker — repeated `RangeError: The number NaN cannot be converted to a BigInt` page
errors from terrain chunk generation — and the spec is not green yet.

## Done

This session (on top of committed `7cf56bf`):
- Reverted all temporary probes from the previous iteration: `app/src/server/shard/shard.ts`
  (T93-SRV console tick probe) and `app/tests/e2e/fixtures.ts` (server console file mirror) are
  back to HEAD. Confirmed clean via `git diff app/src app/tests/e2e/fixtures.ts` → only the
  spec file differs.
- Rewrote leg 4 (RE-ENTER) of `app/tests/e2e/touch-onfoot.spec.ts` and found+fixed the real
  steering bug:
  - **Root cause of the previous infinite spin:** the old loop nudged TOWARD the signed
    bearing (`dir = angle > 0 ? 1 : -1`) — WRONG. Measured on the live page: a yaw +1 burst
    moves the bearing angle toward + (data: θ +2.39 with dir +1 → θ −2.54, i.e. Δ ≡ +1.35 rad;
    every transition fits "yaw +1 adds ~+1.3–1.7 rad to the bearing" within 0.15 rad). The
    sign-chase ping-ponged: dist stuck at 11.69/11.99 m, angle cycling ±2.2…2.7 rad for all
    60 passes, `acked` climbing (server applied every input), prompt always hidden.
  - **Fix:** `const dir = angle > 0 ? -1 : 1` (opposite of the sign), PLUS a restructure:
    each pass (read at rest: 400 ms rest + `charSettled()`) does one of three things:
    (a) prompt === '[E] Open cargo' (in cone, 3–5 m out) → W burst sized to land ~1.8 m out
    (crosses into the ≤ 3 m '[E] Enter ship' zone); (b) hidden AND |bearing| ≤ 0.79 rad (45°)
    → W burst sized to land ~2.5 m out (any facing within 90° shortens the distance AND
    walking along the bearing self-aligns the relative bearing); (c) hidden AND |bearing| > 45°
    → one 100 ms yaw nudge with the corrected sign. Loop cap 60.
  - **Verified convergence** in one run: i=0 dist 11.39 angle −0.89 → i=1 11.39 / +0.46
    (nudge landed in the walk band) → i=2 6.54 / +0.88 (walk burst closed ~5 m; a nudge
    happened because the yaw tail had rotated the facing during the burst — see Dead ends)
    → i=3 6.54 / −0.47 → i=4 **2.98** / −1.64 (inside the 5 m reach, but 94° off-axis →
    needs one more nudge).
- All TEMP probes removed from the spec again before handoff (page console/pageerror/
  framenavigated listeners, in-loop `__CHAR__` probe, angle log). The committed spec file is
  clean code.

## Working tree

- Committed: `7cf56bf wip(TASK-93): on-foot touch layout + shared E/Q paths implemented
  (unit green); e2e legs 1-3 green, leg 4 re-enter steering rewritten, unverified`.
- Uncommitted (this session, my only change): `app/tests/e2e/touch-onfoot.spec.ts` — leg 4
  rewritten as described above (corrected nudge sign, hidden-aligned walk burst, 60-pass cap).
  Probes removed; file is clean.
- Pre-existing dirty files NOT mine — do not commit: `.gitignore`, `.ralph/prd/PRD.md`,
  `ralph.config.json`, ~50 modified `.ralph/screenshots/*.png`, `?? .gitattributes`,
  `?? .ralph/ESCALATION.md`, `?? .ralph/logs/t761/`, `?? .ralph/logs/t83/`,
  `?? .ralph/tasks/TASK-89..95.json`, `?? app/.ralph/`.
- Build state: `npx tsc --noEmit` and the full unit suite were green as of `7cf56bf`; only
  the e2e spec file changed since.

## Next steps

1. Run the spec: `cd app && npx playwright test touch-onfoot.spec.ts --config
   playwright.e2e.config.ts --reporter=line` (single test, 180 s internal timeout).
2. **Debug the new NaN page error** (the current blocker): after the character walked to
   ~3 m of the ship (passes i≥4), the page threw ~16× `RangeError: The number NaN cannot be
   converted to a BigInt because it is not an integer` with stack
   `BigInt ← latticeValue (src/shared/galaxy/noise.ts:43) ← valueNoise (noise.ts:58) ← fbm01
   (noise.ts:72) ← generateSurfaceChunk (src/shared/galaxy/surface.ts:231)` — i.e. the
   client terrain streamer generated a chunk with NaN coordinates. `collectErrors().
   assertClean()` fails on ANY pageerror, and the run also ended before reaching
   '[E] Enter ship'. Investigation ideas, in order:
   a. Add back a temporary in-loop probe (`page.evaluate` over `window.__CHAR__.pos`) and log
      per pass; check whether the character position itself goes NaN/non-finite after the
      walk burst lands at ~2.98 m (a walk burst with a 94°-off-axis facing can carry the
      character PAST the ship and off the pad disc — check y and the pad plane).
   b. Check whether this is pre-existing flake behaviour: run `npx playwright test
      enter-ship.spec.ts walk.spec.ts` in isolation and watch for the same BigInt error.
   c. Likely spec-side hardening if (a) shows overshoot: size the hidden-aligned walk burst
      to land ~3.5 m out (stay in the '[E] Open cargo' zone, let the prompt branch do the
      final 1.8 m approach) instead of 2.5 m — that keeps the character from crossing the
      ship/pad and reduces the tail-rotation exposure.
   d. Note: at i=4 the bearing was −1.64 rad despite a walk burst on the previous pass — the
      yaw release tail (hundreds of ms on this software-GL page) kept rotating the facing
      DURING the walk burst. The walk-band threshold (0.79 rad) and the 400 ms rest +
      charSettled() after each action mitigate this; if walks keep landing off-axis, the
      2–3 extra nudge passes the 60-cap allows are fine (convergence was ~1 pass per 4 m).
3. Once green: screenshot `.ralph/screenshots/TASK-93-1.png` is written by the spec itself
   (leg 4, prompt up — it has NOT been generated yet because the spec fails before it).
4. Regression per the spec's step 2: keyboard specs must stay green (walk, interact, mining,
   enter-ship, disembark, inventory — the extracted E/Q paths are behaviour-identical),
   `npx tsc --noEmit`, full `npm run test`, `eslint --fix` + `prettier --write` on the spec.
5. Bookkeeping: set both steps `pass: true` in `.ralph/tasks/TASK-93.json`, `passes: true` in
   `.ralph/tasks.json`, LOG.md entry (newest first) + 'Tasks Completed' bump, delete this
   handoff, commit `feat(TASK-93): touch on-foot: move stick + run/jump/drop/interact
   (shared E/Q paths)` (one commit; exclude the pre-existing dirty files listed above).

## Dead ends

- **Nudging toward the signed bearing** (`dir = angle > 0 ? 1 : -1`, the intuitive choice):
  ping-pong forever. The measured turn direction is opposite: yaw +1 adds ~+1.3–1.7 rad to
  the bearing angle. 60 passes, dist constant at 11.69/11.99 m. Fixed by flipping the sign.
- **Burst-length control of turn amount:** a 100 ms yaw burst turns ~70–90° total on this
  page (the release event is delayed 400–600 ms by the software-GL main thread), NOT ~17°.
  Design around ~70–90° effective nudges: only nudge when |bearing| > 45° (any nudge leaves
  residue ≤ ~90°, so ≤ 2 nudges reach the walk band), and walk (not nudge) when |bearing| ≤ 45°.
- **Server-side console probing:** the e2e fixture swallows server stdio
  (`app/tests/e2e/fixtures.ts` `bootServer`); a file-mirror probe was added then reverted —
  unnecessary, the client `__CHAR__` (server-authoritative 10 Hz) is sufficient for steering.
- **`charPos` 15 s timeout with the character visible** (pre-flip run, line 450):
  `window.__CHAR__.pos` was null while the character spun in place at 11.99 m. Did not
  reproduce after the sign flip. If it recurs, probe `__CHAR__` state (pos-null vs hook
  missing vs finite) in-loop as in step 2a above.

## How to verify

Per `.ralph/tasks/TASK-93.json` step 2 + ACs: `touch-onfoot.spec.ts` green (all 4 legs:
layout present + flight sticks absent; MOVE thrust ≥ 4 m server-side; yaw burst turns
heading; interrupted mine awards nothing + full mine awards 1/40u; steer-back re-enters via
INTERACT, docked stubs return, on-foot layout gone) with screenshot
`.ralph/screenshots/TASK-93-1.png`; keyboard regression specs green (existing E/Q behaviour
identical); `npx tsc --noEmit` green; full `npm run test` green; one commit.
