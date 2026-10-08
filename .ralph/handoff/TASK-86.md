# TASK-86 handoff — Undock fix: a docked ship has no way to take off

## Status
All code for the task is now WRITTEN (Option A from the DECIDE: `VTOL_LIFT =
1.35 × GRAVITY` + a second client-scheme fix found via e2e diagnostics), but
the final e2e verification has not run yet: the last uncommitted change
(`main.tsx` surface-scheme read) was applied in the final minutes of this
iteration and has NOT been tested. Remaining: verify the pad e2e, strip the
temporary diagnostics, run the full verification matrix, close out.

## Done
- **Root cause 1 (committed `e252fc1`):** client regime tracker snapped a
  pad-docked ship's active regime to `surface` → CHARACTER key scheme → W
  read as zero flight demand → the TASK-78 dock gate suppressed the first
  input frame. Fixed: `readSchemeInput` in `controls.ts`; `anyFlightDemand`
  + `dockedFlightScheme` in `flight-loop.ts`; `main.tsx` reads demand
  through `dockedFlightScheme` while `wireDockedIndicator()`. 5 unit tests
  in `flight-loop.test.ts`.
- **E2E 409 (committed `a1bf317`):** `/api/dev/teleport` resolves the shard
  by the ship ROW's `position.systemId`, which only `warp` writes. Both
  specs now use the disembark pattern: raw-WS join home → warp → teleport
  (y = pad.y + 5) → server-authoritative docked poll.
- **Option A physics change (this iteration, UNCOMMITTED):**
  - `app/src/shared/physics/flight.ts` — `VTOL_LIFT = 1.35 * GRAVITY` (+ doc
    comment: net +0.35·g climb, drag-limited terminal climb speed, hover is
    no longer the rest point). Client/server parity is automatic (shared).
  - `app/src/shared/physics/flight.test.ts` — the "VTOL hover converges"
    test is now "VTOL full lift climbs (TASK-86)": asserts vel.y > 1
    climbing, altitude gained, drag-capped (< 6 u/s at density 1), sustained
    climb. GOLDEN FIXTURES UNCHANGED (both use `up: 0` — verified).
  - `app/src/server/shard/shard.pads.test.ts` — header reworded; scenario (b)
    takeoff is now the REAL player path: holds `frames({ action: 'vtol' })`
    up to 30 ticks, asserts the single pad-undock lands in
    `[takeoffTick+1, takeoffTick+15]` (the climb crosses the 2 u/s release
    threshold in ~12 ticks); phase-1/phase-4 comment fixes.
  - `app/src/server/shard/shard.pads.approach.test.ts` — header reworded
    (lift now EXCEEDS gravity; early VTOL switch-on would climb away); the
    "stays docked" rest changed from VTOL-held to IDLE frames (a VTOL-held
    rest now legitimately undocks in ~12 ticks).
  - `app/src/server/shard/shard.test.ts` — "VTOL lift settles a ship on the
    pad" reworked: drops from ground+60 (not +10), switches VTOL on only
    below ground+5, lands, then rests on IDLE frames (VTOL-held would climb
    off). Same end assertions (settled, onPad, wire 'docked').
  - `app/tests/e2e/atmosphere-sky.spec.ts` — comments only (hover → climbs;
    the test re-pins via teleport so it is unaffected).
- **Root cause 2 (this iteration, UNCOMMITTED, UNVERIFIED):** with the
  physics fix, the pad e2e still failed — DIAG (an outgoing-input tap, see
  Working tree) showed the client sending `action:'vtol'` frames INTERLEAVED
  with zero-demand frames. Cycle: server clears `padId` (|vel.y| ≥ 2) → wire
  flips `sublight` → client `wireDockedIndicator()` false → flight loop fell
  back to the ACTIVE scheme, which is CHARACTER while the client regime is
  still `surface` → Space/VTOL demand dropped → ship falls back → re-docks.
  Fix in `app/src/client/main.tsx` (flight-loop effect):
  `const flightScheme = docked || regimeWiring.regime === 'surface'` —
  read through `readSchemeInput(dockedFlightScheme(...))` in both cases.
  NOT YET RUN (no unit test targets this inline main.tsx logic; the e2e is
  the coverage).
- **Verified (this iteration):** targeted units flight + shards.pads +
  shards.pads.approach = 37/37 GREEN (the real-VTOL SimLoop takeoff works);
  `npx tsc --noEmit` clean (before the main.tsx edit); eslint --fix +
  prettier clean on all physics/test/e2e files; e2e: `undock.spec.ts`
  HOME-DOCK GREEN, `docked-indicator.spec.ts` GREEN, pad-dock RED (root
  cause 2, now fixed in code but unverified).

## Working tree
UNCOMMITTED (all mine — commit them together with this handoff):
- `app/src/shared/physics/flight.ts` (M — VTOL_LIFT 1.35×)
- `app/src/shared/physics/flight.test.ts` (M — climb test)
- `app/src/server/shard/shard.pads.test.ts` (M)
- `app/src/server/shard/shard.pads.approach.test.ts` (M)
- `app/src/server/shard/shard.test.ts` (M — VTOL landing test rework)
- `app/src/client/main.tsx` (M — surface-scheme read, UNVERIFIED)
- `app/tests/e2e/undock.spec.ts` (M — pad test now holds SPACE; pollUndock
  gained a `key` param; TEMP DIAG added: `__sentInputs` outgoing-frame tap
  in `tapShipUpdates` + a try/catch console.log block around the pad
  pollUndock call — REMOVE both before close-out; the `flightRegime` field
  added to the `__shipUpdates` push is harmless and may stay)
- `app/tests/e2e/atmosphere-sky.spec.ts` (M — comments only)

NOT mine — leave alone (pre-existing dirty): `.gitignore`,
`.ralph/tasks.json`, `ralph.config.json`, `.ralph/decisions.jsonl`,
`?? .gitattributes`, `?? .ralph/ESCALATION.md`, `?? .ralph/logs/t761/`,
`?? .ralph/logs/t83/`, `?? .ralph/tasks/TASK-86.json`, `?? TASK-87.json`,
`?? TASK-88.json`, all `M .ralph/screenshots/*.png` (do NOT commit per
task note).

Committed before: `e252fc1` (client fix + flight-loop units + undock spec),
`a1bf317` (e2e 409 fix + handoff). Builds: tsc was clean before the
main.tsx edit; re-run it.

## Next steps
1. `cd app && npx playwright test --config playwright.e2e.config.ts
   tests/e2e/undock.spec.ts` — the pad test should now pass (VTOL demand
   survives the ascent). If red: re-add/keep the DIAG tap, confirm `vtol`
   frames flow CONTINUOUSLY and the wire regime leaves 'docked'.
2. Strip the DIAG: remove the `__sentInputs` tap from `tapShipUpdates` and
   the try/catch diag block in the pad test.
3. Full matrix: `npx tsc --noEmit`; `npm run test` (full — the shard.test.ts
   fix has not been re-run in the full suite; expect all green); e2e
   `undock.spec.ts` + `docked-indicator.spec.ts` + `disembark.spec.ts` +
   `enter-ship.spec.ts` + `flight.spec.ts` + `core-flow.spec.ts` via
   `npx playwright test --config playwright.e2e.config.ts <files>`
   (single worker; the e2e harness self-boots its own dev server per file);
   `eslint --fix` + `prettier --write` on ALL touched files (main.tsx,
   flight.ts, the three shard/physics test files, both e2e specs).
4. Look at `.ralph/screenshots/TASK-86-1.png` (the spec saves it mid-flight,
   off the pad — ship must be in the air).
5. Close out: `passes: true` for TASK-86 in `.ralph/tasks.json` + steps 1-4
   `pass: true` in `.ralph/tasks/TASK-86.json`; LOG.md entry at top (date
   2026-10-08, summary incl. the 1.35×g margin + the two client scheme
   fixes, screenshot path); bump 'Tasks Completed' 101 → 102; commit
   `fix(TASK-86): ...` (Conventional Commit, include the WIP commits' files);
   delete this handoff.

## Dead ends
- **W does not take a pad-docked ship off — Space (VTOL) does.** Thrust is
  space-only in `integrateStep`; in atmosphere/surface only VTOL lift
  applies. The pad e2e MUST hold Space. (The home-dock test keeps W — its
  flightRegime is 'space'.)
- **A VTOL-HELD rest on a pad now undocks in ~12 ticks** (the 0.35·g
  margin). Any "stays docked while VTOL held" assertion is now asserting
  WRONG behavior — docked rests must use idle frames (the TASK-78 wire
  behavior).
- **Gating the flight-scheme read on `wireDockedIndicator()` alone is
  INSUFFICIENT** — the wire flips to 'sublight' mid-ascent while the client
  regime is still 'surface'; the character scheme then drops the VTOL
  demand and the ship re-docks (oscillation, DIAG-verified). The gate must
  be `docked || regimeWiring.regime === 'surface'`.
- Do NOT "fix" the v1 model by touching the pad machine, the dock gate, or
  server dock code for the pad takeoff — the physics margin is the fix
  (DECIDE answered: Option A).
- Teleport 409: keep the raw-WS join-home → warp → teleport (y+5) pattern;
  a browser boot straight into `?sys=` leaves the ship row on home → 409.
- `#docked-indicator` offsetParent check is UNRELIABLE (fixed positioning);
  assert via Playwright locators.
- Full unit suite under load flakes: one run had 4 spurious file failures
  (happy-dom AbortError / timing) that passed green in the re-run. If the
  full `npm run test` shows a single-file oddity, re-run it isolated before
  believing it.

## How to verify
- Units: `cd app && npx vitest run src/shared/physics/flight.test.ts
  src/server/shard/shard.pads.test.ts src/server/shard/shard.pads.approach.test.ts
  src/server/shard/shard.test.ts` → all pass (first three confirmed 37/37
  this iteration; shard.test.ts fix written after that run).
- Client units (unchanged, must stay green): `npx vitest run
  src/client/input/flight-loop.test.ts` → 8 pass.
- tsc: `cd app && npx tsc --noEmit` → clean.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts
  tests/e2e/undock.spec.ts tests/e2e/docked-indicator.spec.ts` → the pad
  test is the open one (home-dock + docked-indicator green this iteration);
  then the step-4 regression list.
