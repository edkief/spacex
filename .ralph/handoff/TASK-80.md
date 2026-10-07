# TASK-80 handoff: Controls A/D (yaw) and Q/E (roll) mirrored — D must turn right

## Status
All code is implemented, unit-tested green, and the new e2e `controls-direction.spec.ts` PASSES
(ship D dot=0.821 > 0.2, A dot=−0.740 < −0.2, on-foot D dot=0.864 > 0.2) with the required
screenshot visually verified (nose points right of the chase camera). What remains is
BOOKKEEPING ONLY: close out the remaining e2e regression list, run the final full unit suite,
flip the 5 step flags + `passes: true`, LOG.md entry, commit as `fix(TASK-80): ...` (do NOT use
the wip commit as the final commit — it must be amended or followed by a proper commit).

## Done
1. **Step 1 — failing tests first (written, seen fail pre-fix):**
   - `app/src/client/input/controls.test.ts`: new describe `keys → on-screen direction (TASK-80: D must turn RIGHT)` — a `steer(key, secs, regime)` helper runs `remapper.readInput(new Set([key]))` through `integrateShip` (20 Hz, 0.5 s, identity quat, scout class, atmosphereDensity 0) and asserts on-screen direction off the final quat: D → forward.x < 0, A → forward.x > 0, Q → up.x > 0, E → up.x < 0, R → forward.y < 0 / F → forward.y > 0 (pitch unchanged), plus the same D/A on the atmosphere scheme. Frame comment included. All failed pre-fix (measured: D gave forward.x = +0.389, Q up.x = −0.389).
   - `app/src/shared/physics/character.test.ts`: new test `turn direction (TASK-80)` in the speeds describe — right:true 0.5 s from identity → forward x < 0; left:true → x > 0. Failed pre-fix (x = +0.997).
2. **Step 2 — ship fix (client input mapping only):**
   - `app/src/client/input/controls.ts` `readInput`: `yaw: flip(axis(s.yaw))`, `roll: flip(axis(s.roll))` — ONE sign translation; `flip` normalizes −0 → +0 (toEqual distinguishes −0/+0 and broke the existing idle-frame test otherwise). Thrust/pitch/up untouched. Doc comments fixed on `ControlScheme.yaw`/`roll` (which key is which on screen) and on `readInput` (why the negation).
   - `app/src/shared/physics/flight.ts`: block comment on `ShipInput` stating the physics convention (+yaw = nose toward local +X = screen LEFT; +roll = clockwise seen from behind = roll RIGHT; right-handed, +Y up, +Z forward). **integrateShip / quatFromEuler / AI / wire mapping UNCHANGED.**
   - `app/src/client/input/controls.test.ts` existing `readInput maps pressed keys...` test: D now expects `yaw: -1`, A expects `yaw: 1` (expectation changed, not deleted).
3. **Step 3 — on-foot fix (shared character step):**
   - `app/src/shared/physics/character.ts` `characterSubstep`: `right` now rotates by **−**CHAR_TURN_RATE·h about +Y, `left` by **+**; doc comments on `CharacterInput.left/right` corrected (they said right = +yaw).
   - `app/src/shared/physics/character.test.ts` existing `turning: right/left yaw the facing...` test: expectation flipped to `quatFromEuler(-CHAR_TURN_RATE, 0, 0)` and fwdNow.x negative (expectation changed, not deleted).
   - **FIXTURE REGENERATED:** `app/src/server/shard/__fixtures__/character-walk-30s.json` was regenerated with `CHAR_WALK_FIXTURE=1 npx vitest run src/server/shard/shard.character.walk.test.ts` — the scripted 30 s walk turns in the new (correct) direction, so the committed path legitimately changes. It is green in comparison mode after regeneration. This is the ONLY committed artifact whose numbers changed; flight fixtures, determinism, and AI tests are untouched and green.
4. **Step 4 — e2e (written + green):** `app/tests/e2e/controls-direction.spec.ts` — single test, full flow: claim → `__SELF_SHIP__` probe armed → 300 ms W tap (undock) → `POST /api/dev/teleport` (0, 50, 3000) → read `probe().rot` → inline quaternion math (spec inlines quatRotate; Playwright can't import @shared) → D 1 s → dot(forward, right0) > 0.2 → screenshot `.ralph/screenshots/TASK-80-1.png` → A 2 s (swings 1.6 rad through and past the initial facing) → dot < −0.2 → dockAtPad (pad-target → warp if needed → pad teleport → server-authoritative docked wait) → `?sys=` reload → E disembark → poll `window.__CHAR__.pos` → D 0.5 s → poll `window.__CHAR__.rot` (server 10 Hz facing) → dot > 0.2. **PASSED in 15.0 s.** Screenshot LOOKED AT: ship nose clearly points screen-right from the chase camera.
5. **Lint/format:** eslint --fix + prettier --write applied to all 6 touched source files + the new spec. `npx tsc --noEmit` clean.

## Working tree
- **NOT YET COMMITTED** (a `wip(TASK-80)` commit is made at handoff):
  - `app/src/client/input/controls.ts`, `app/src/client/input/controls.test.ts`
  - `app/src/shared/physics/character.ts`, `app/src/shared/physics/character.test.ts`, `app/src/shared/physics/flight.ts`
  - `app/src/server/shard/__fixtures__/character-walk-30s.json` (regenerated)
  - `app/tests/e2e/controls-direction.spec.ts` (new)
  - `.ralph/screenshots/TASK-80-1.png` (new)
- **DO NOT COMMIT** the pre-existing dirty `.ralph/screenshots/*.png` mods and `ralph.config.json` (task note: "Do NOT commit the pre-existing dirty screenshots"; ralph.config.json is Ralph's own bookkeeping).
- Builds: `npx tsc --noEmit` green. Unit suite: everything green EXCEPT one pre-existing flake, `src/server/galaxy/enter-ship.ws.test.ts` ("disembark → re-enter round trip"), which failed ONCE in the full parallel run and passed in isolation (the documented load-flake family from prior LOG entries) — re-run in isolation before closing out.

## Next steps (in order)
1. Re-run the touched e2e regression list (the spec's step 5): `npx playwright test --config=playwright.e2e.config.ts tests/e2e/controls-direction.spec.ts tests/e2e/flight.spec.ts tests/e2e/walk.spec.ts tests/e2e/disembark.spec.ts tests/e2e/enter-ship.spec.ts tests/e2e/determinism.spec.ts tests/e2e/rogue-ai.spec.ts tests/e2e/keyboard-only.spec.ts`
   - flight, walk, disembark, enter-ship, determinism, rogue-ai were all GREEN this session (6 passed, 1.2 m). controls-direction green. **Only keyboard-only is red — see Dead ends.**
2. Full unit suite: `cd app && npm run test` — expect ~182 files / ~1653 tests; re-run `src/server/galaxy/enter-ship.ws.test.ts` in isolation if it flakes under load.
3. Close out: set the 5 step `pass: true` flags in `.ralph/tasks/TASK-80.json`; `"passes": true` for TASK-80 in `.ralph/tasks.json` (the entry is at line ~701); LOG.md entry at the TOP (include the SHIP_RIGHT_LOCAL follow-up note from step 3: `characterSpawnPos`/`SHIP_RIGHT_LOCAL` in character.ts use +X as the ship's "right", which is really the ship's LEFT — cosmetic spawn offset, out of scope for TASK-80); no STRUCTURE.md change (no new dirs — the e2e spec lives in the existing `app/tests/e2e/`).
4. Final commit `fix(TASK-80): controls no longer mirrored — D turns right and Q/E roll correctly (client readInput sign flip + character turn direction)` (amend the wip commit or commit on top — one logical commit; do NOT include the dirty screenshots or ralph.config.json).
5. Output `<promise>TASK-80:DONE</promise>`.

## Dead ends
- **keyboard-only.spec.ts `#weight-bar` timeout — PRE-EXISTING, NOT a TASK-80 regression.** Verified by stashing ALL my source changes and running the spec at pristine HEAD: it fails identically (character is visible on the pad in the failure screenshot, no `#docked-indicator`, guidance hint up — but `#weight-bar` never renders; on-foot-hud.spec.ts, the sibling that asserts the same element, also fails at HEAD). Hypothesis: `hudMode` (main.tsx:944 `setHudMode('onfoot')`) is only set when a self entity_update with kind 'character' + onFoot arrives AFTER the camera handoff; in some runs the 20 s wait exhausts. Investigating this properly is OUT OF SCOPE for TASK-80 — if it still fails at close-out, record it in the LOG entry as a pre-existing failure verified at HEAD (stash-and-retest evidence above) exactly like prior tasks recorded pre-existing reds, and close TASK-80 on the rest of step 5's list. Do NOT fix it in this task.
- **Wire `rot` is omitted when identity** (schema: "omitted when the quaternion is identity"): the disembark facing IS identity, so `window.__CHAR__.rot` stays undefined until the first real turn. The spec handles this (cRot0 falls back to the identity quat; waits for a non-identity rot AFTER holding D). First e2e run failed on exactly this — fixed, do not revert.
- **−0 in readInput:** a plain `-axis(...)` yields −0 when idle and `toEqual` fails against `+0`. `flip()` normalizes it. Don't "simplify" it away.

## How to verify
- Unit: `cd app && npx vitest run src/client/input/controls.test.ts src/shared/physics/character.test.ts src/shared/protocol src/server/shard` (all green; the TASK-80 tests in controls.test.ts assert on-screen direction through the real integrateShip, so a physics change would fail them).
- Direction e2e: `cd app && npx playwright test --config=playwright.e2e.config.ts tests/e2e/controls-direction.spec.ts` (15 s; prints `ship D dot=… A dot=… on-foot D dot=…`).
- Physics unchanged proof: flight fixtures / determinism / AI tests green untouched; `src/shared/protocol/inputs.test.ts` round-trip green.
- Screenshot: `.ralph/screenshots/TASK-80-1.png` — nose points screen-right after holding D.
