# TASK-78 handoff — rigid chase camera (camera drop-off 2/3)

## Status

TASK-78's own fix is COMPLETE and PROVEN (all code committed, e2e green, screenshots
verified). The ONE remaining blocker: `tests/e2e/targeting.spec.ts` fails DETERMINISTICALLY
(3/3 isolated runs, no load) — a pre-existing regression from the TASK-73/77 input-loop
change (NOT from TASK-78), where the starter scout at the home dock gets UNDOCKED by idle
client input frames and is then killed by rogue AI before the T-lock assert. Fix that,
re-run the spec list, then it is pure bookkeeping close-out (~15 min).

## Done

- **TASK-78 fix — committed in `3c0550b` + `5f2ff2a` + `02dea95`** (re-verified this
  session): `rigidChasePose` in `app/src/client/camera/pose-math.ts`; `CameraRig` chase
  mode = `viewQuat.slerp(shipQuat, 1 - exp(-CHASE_ROT_K·dt))` (CHASE_ROT_K = 6) + RIGID
  pose application, no position lerp; viewQuat armed on prime/resetPrime/handoff-into-chase.
  Cockpit/onfoot/600 ms handoff untouched.
- **Proven this session (fresh runs):**
  - `npx tsc --noEmit` clean; camera unit tests 45/45 (`npx vitest run src/client/camera/`).
  - `tests/e2e/chase-camera.spec.ts` GREEN (24.3 s): TASK-78 window spawn→cap — cam→ship
    **14.56..14.56 u on EVERY frame in EVERY speed bucket** (n=27..34 per bucket, AC
    14.6 ± 0.5), ship screen **max dev 0.0 px** (AC 20); TASK-77 AC green in same run
    (max dev excl rewind 2.32 ≤ 3).
  - Screenshots `.ralph/screenshots/TASK-78-1.png` (SPD 30.0 m/s) / `-2.png` (SPD 120.0
    m/s) LOOKED AT: ship is **pixel-identical size** in both — the AC-4 visual check passes.
  - Pre-fix record (from prior handoff, keep in the LOG entry): at ≥100 u/s distance grew
    to 23.0..30.3 u (2× the designed 14.56), screen dev 82.5 px.
- Regression e2e batch run this session: **flight, self-ship, camera-handoff, enter-ship,
  disembark, weapons all GREEN**; only `targeting.spec.ts` red (see below).

## Working tree

- Code: CLEAN — all TASK-78 code committed through `02dea95`. Working tree = HEAD plus
  the KNOWN DIRTY files to NOT commit: ~30 pre-existing `.ralph/screenshots/*.png` mods,
  `.ralph/decisions.jsonl`, `ralph.config.json`, untracked `.ralph/logs/t761/`.
  (This session checked out camera files from an older commit mid-bisect and RESTORED
  them to `02dea95` — verify with `git status`: `app/src/client/camera/` must be clean.)
- Builds: tsc clean; unit suite was 183 files / 1673 passed / 1 skipped (prior session,
  isolated run) — re-run before the final commit.
- Dev server: NOT running (killed this session). e2e uses its OWN server via the
  `e2eServer` fixture (`npm run dev:test` on its own ports) — do NOT start a manual
  `npm run dev` while running e2e; it doubles the load and was a red herring here.

## Next steps

1. **Fix the targeting regression (the real blocker).** Symptom: in
   `tests/e2e/targeting.spec.ts` the page snapshot at failure shows
   `SHIP LOST — Killed by ai:<system>:<n>` + respawned pad-docked (`DOCKED · Nerind
   STATION`). Root-cause chain (traced this session):
   - Claim spawns the starter scout with `state: 'docked'` at the **home dock position**
     (`src/server/routes/callsigns.ts` ~line 88, `getOrCreateStarterShip`; home dock is a
     position, NOT a pad → no padId, persisted regime 'space').
   - `app/src/server/shard/shard.ts` ~line 1888: any received input frame on a docked
     entity does `entity.docked = false` ("first input = take-off").
   - `app/src/client/main.tsx` flight loop (the TASK-77 PRE-RENDER hook, ~lines 1560-1620)
     gates idle-frame suppression on `dockedIndicator()` — but
     `app/src/client/state/docked.ts` `isDocked` requires wire regime 'docked' **AND a
     padId**, so a home-dock-docked starter reads NOT docked → the client sends 20 Hz
     idle zero-input frames → the server undocks the ship ~instantly → rogue AI
     (6-10 per system, aggro 600 m, `src/server/shard/ai.ts`; docked ships ARE excluded
     via `stepAiShips` `players` filter ~line 1504, which is why it dies only AFTER the
     stray undock) kills it during the spec's 10×1.5 s T-press loop.
   - Why now: targeting last went green in the TASK-74 window (pre TASK-73/77). The
     TASK-73/77 input-loop rewrite is what made idle frames flow while the pad-based
     indicator is false. (Verified NOT a TASK-78 regression: camera dir checked out at
     `fbab4c3` = targeting still failed identically.)
   - **Proposed fix (client-side, minimal):** in the flight-loop `docked` gate in
     `main.tsx`, treat the ship as docked for the no-idle-frames rule whenever the wire
     self-entity says docked — check what the 10 Hz self entity bridge knows (regime /
     padId / any wire 'docked' flag — grep `setDockedIndicator` call sites in main.tsx
     and the `entityToState` wire in `src/shared/protocol/`) and widen that single
     boolean's input (e.g. a second source in `state/docked.ts` fed by the self entity's
     docked state) rather than the pad-only predicate. Keep the pad indicator UI behavior
     unchanged (its e2e: enter-ship/disembark use `#docked-indicator`). Do NOT weaken
     "first input = take-off" server behavior (it is tested); the fix is to STOP sending
     idle frames while the server-side entity is docked. Unit-test the new gate in
     `state/docked.test.ts` / the flight-loop test if one exists.
2. Re-run the step-4 e2e list isolated, one batch:
   `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/chase-camera.spec.ts tests/e2e/flight.spec.ts tests/e2e/self-ship.spec.ts tests/e2e/camera-handoff.spec.ts tests/e2e/enter-ship.spec.ts tests/e2e/disembark.spec.ts tests/e2e/weapons.spec.ts tests/e2e/targeting.spec.ts`
   (targeting needs the fix; the others were green this session and should stay green.)
3. `cd app && npx tsc --noEmit`; full `npm run test`; `eslint --fix` + `prettier --write`
   on touched files.
4. Close-out bookkeeping:
   - `.ralph/tasks.json`: TASK-78 `passes: true`
   - `.ralph/tasks/TASK-78.json`: all 4 steps `pass: true`
   - `.ralph/logs/LOG.md` entry at top: pre-fix buckets (≥100 u/s 23.0..30.3 u, screen
     82.5 px) vs post-fix (every bucket 14.56 u, screen 0.0 px), screenshot paths
     TASK-78-1/2.png, the verified matrix, the targeting-regression fix summary; bump
     'Tasks Completed' 95 → 96
   - delete this handoff
   - commit `fix(TASK-78): ...` — include the targeting-regression fix in it (it is on
     this task's e2e gate); DO NOT commit the pre-existing dirty png/decisions/config files
5. Then output `<promise>TASK-78:DONE</promise>`.

## Dead ends

- Re-running targeting in isolation does NOT clear it — 3/3 failures with a clean
  machine (no manual dev server, no concurrent vitest). It is deterministic, not the
  load-flake family the previous handoff suspected.
- Checking out the pre-TASK-78 camera dir (`fbab4c3`) to test: still failed — ruled out
  the chase-camera change as the cause. (Files were restored afterward.)
- `disembark` / `enter-ship` / `weapons` failures in the previous handoff were under
  concurrent load; all three were GREEN in this session's isolated batch run.
- Don't chase "rogue AI targets docked ships" — it's guarded correctly
  (`stepAiShips` skips docked entities; `combat.ts` docked gate); the ship is only
  vulnerable because the client's stray idle input frame UNDOCKS it first.

## How to verify

- `cd app && npx tsc --noEmit` → clean.
- `cd app && npx vitest run src/client/camera/` → 45/45.
- `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/chase-camera.spec.ts`
  → 1 passed (~24 s); console prints the TASK-78 line: every speed bucket 14.56..14.56 u,
  screen max dev 0.0 px.
- `tests/e2e/targeting.spec.ts` green ONLY AFTER the docked-gate fix (currently fails
  with SHIP LOST in the error snapshot).
- Look at `.ralph/screenshots/TASK-78-1.png` vs `TASK-78-2.png`: ship same size at
  30 vs 120 m/s (already verified).
