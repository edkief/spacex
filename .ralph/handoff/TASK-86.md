# TASK-86 handoff — Undock fix: a docked ship has no way to take off

## Status
Root cause found and fixed (client-only, 3 files); the new unit tests pass green and the new
e2e spec's HOME-DOCK test passes. The PAD-DOCK e2e test is blocked by a pre-existing 409 from
`/api/dev/teleport` that ALSO breaks the existing `docked-indicator.spec.ts` (unrelated to this
fix — it is server-side REST, not the input path). Remaining: resolve that 409, run the full
verification matrix, and close out (flags + LOG + commit).

## Done
- **Root cause (step 1, confirmed by reading + a red unit test):** a PAD-docked ship carries
  wire regime `docked` AND `flightRegime: 'surface'`. The client regime tracker
  (`RegimeTracker.updateLocal`, surface is server-authoritative) snaps the active regime to
  `surface`, which remaps keys to the **character** scheme (`CONTROL_SCHEMES.surface` has
  `thrust: null, yaw: null, ...`). So `remapper.readInput(W)` returns a **zero** flight demand,
  `nonzero` is false, and the TASK-78 dock gate in `main.tsx`
  (`const seq = !docked || nonzero ? ... : null`) suppresses the frame. The server's
  "first input = take-off" (`shard.ts:1888`) never fires → ship stays docked forever.
  The HOME dock has `flightRegime: 'space'` (space scheme → W reads thrust +1), which is why
  `flight.spec.ts` undocks fine from spawn. Pre-fix the unit test measured thrust `+0` (RED).
- **Fix (step 2, client-only, does NOT touch the docked-state plumbing per spec):**
  - `src/client/input/controls.ts`: extracted the scheme→demand math into a new PURE export
    `readSchemeInput(scheme, pressed)`; `ControlsRemapper.readInput` now delegates to it
    (byte-identical behavior for the active scheme).
  - `src/client/input/flight-loop.ts`: added `anyFlightDemand(input)` (the old inline
    `nonzero` predicate) and `dockedFlightScheme(regime)` which maps
    `surface → CONTROL_SCHEMES.atmosphere` (full flight + VTOL lift) and passes
    space/atmosphere through unchanged.
  - `src/client/main.tsx` flight body (~line 1654): while `wireDockedIndicator()` is true the
    demand is read through `readSchemeInput(dockedFlightScheme(regimeWiring.regime), pressed)`
    instead of `regimeWiring.remapper.readInput(pressed)`; `nonzero` now calls
    `anyFlightDemand(input)`. Idle frames while docked are STILL suppressed (TASK-78 invariant
    preserved) — only a real (non-zero) demand gets a seq and is sent.
- **Unit tests (step 1, all green):** 5 new cases in `src/client/input/flight-loop.test.ts`
  under `describe('docked undock contract (TASK-86)')`: pad-docked W → seq 1 (RED pre-fix);
  home-docked W → seq 1; TASK-78 invariant (10 idle frames @20Hz while docked → nothing sent,
  seq stays 0, then un-docked idle DOES send); seq continuity across the dock→undock flip
  (1,2,3, no gap/repeat); `dockedFlightScheme` mapping + VTOL key present.
- **E2E spec (step 3):** new `tests/e2e/undock.spec.ts`, 2 tests (both claim fresh + tap the
  browser's own inbound entity_updates via a WebSocket init-script subclass):
  (1) pad dock — boot in pad system, dev-teleport onto pad, DOCKED indicator visible, idle
  frozen for 2 s (regime stays docked + pos unchanged), hold W → wire regime leaves docked
  AND pos moves >5 u within 5 s, indicator clears, `__SELF_SHIP__.probe()` in view, screenshot
  `.ralph/screenshots/TASK-86-1.png`; (2) home dock — starter spawns docked (regime 'docked',
  no padId), hold W → undocks + moves >5 u.
- **Verified this session:** `npx tsc --noEmit` clean (background run finished TSC_DONE, no
  errors); `npx vitest run src/client/input/` 43 passed; e2e `undock.spec.ts` — HOME-DOCK
  test PASSED, PAD-DOCK test failed at `expect(tele.status()).toBe(200)` → got **409**.

## Working tree
UNCOMMITTED (all mine, ready to commit together with this handoff):
- `app/src/client/input/controls.ts` (M)
- `app/src/client/input/flight-loop.ts` (M)
- `app/src/client/input/flight-loop.test.ts` (M)
- `app/src/client/main.tsx` (M)
- `app/tests/e2e/undock.spec.ts` (new, ??)
- `.ralph/handoff/TASK-86.md` (this file)

NOT mine — leave alone (pre-existing dirty): `.gitignore`, `.ralph/tasks.json`,
`ralph.config.json`, `?? .gitattributes`, `?? .ralph/ESCALATION.md`, `?? .ralph/logs/t761/`,
`?? .ralph/logs/t83/`, `?? .ralph/tasks/TASK-86.json`, `?? .ralph/tasks/TASK-87.json`,
`?? .ralph/tasks/TASK-88.json`, and all `M .ralph/screenshots/*.png` (do NOT commit the dirty
screenshots per the task note). Build is green (tsc clean, units green). Dev server was
killed at handoff (was running on :3000 via `npm run dev` from `app/`).

## Next steps
1. **Diagnose the pad-dock 409 first.** The 409 body is one of two codes (dev.ts ~219-243):
   `not-in-system` (ship's DB `position.systemId` has no active shard) or `teleport-failed`
   ("ship entity not in the shard"). The e2e boots the browser straight into the pad system via
   `?sys=` — the ship's DB row may still point at the home system, so `router.active(ship.
   position.systemId)` in `dev.ts` returns undefined → 409. Compare with `docked-indicator.
   spec.ts` (same flow, also 409 now) and `disembark.spec.ts` (works) — the difference is how
   each gets the ship INTO the pad's active shard. A working e2e joins the home system over raw
   WS first (which activates the home shard and moves/persists the ship row) before the pad
   teleport, OR warps. Likely fix in the SPEC (not the app): raw-WS join home → warp to pad
   system (like disembark.spec.ts lines 75-92) before the dev-teleport. Re-run
   `npx playwright test --config playwright.e2e.config.ts tests/e2e/undock.spec.ts`.
2. **Confirm the 409 is pre-existing, not from my change:** `git stash` my 5 files, run
   `docked-indicator.spec.ts` (expect the same 409 → pre-existing), `git stash pop`. My change
   is client input-path only and cannot affect the dev REST teleport, so this should confirm it.
3. Verify the screenshot `.ralph/screenshots/TASK-86-1.png` shows the ship IN THE AIR, off the pad.
4. Full verification (step 4): `cd app && npx tsc --noEmit`; full `npm run test`; e2e
   `undock.spec.ts` + `docked-indicator.spec.ts` + `disembark.spec.ts` + `enter-ship.spec.ts` +
   `flight.spec.ts` + `core-flow.spec.ts` via `npx playwright test --config playwright.e2e.
   config.ts <files>`; `eslint --fix` + `prettier --write` on the 5 touched files.
5. Close out: set `passes: true` for TASK-86 in `.ralph/tasks.json` and all 4 steps `pass: true`
   in `.ralph/tasks/TASK-86.json`; add LOG.md entry at top (date, summary, screenshot path);
   commit `fix(TASK-86): ...`. Delete this handoff.

## Dead ends
- The 409 from `/api/dev/teleport` in the pad flow — not yet root-caused. It reproduces on the
  EXISTING `docked-indicator.spec.ts` too, so it is NOT caused by the TASK-86 input fix (which
  is client-side only). It is a server REST/shard-activation sequencing issue in how the spec
  places the ship into the pad's active shard, not in the undock logic. Do NOT "fix" it by
  touching the flight loop or server dock code — the fix belongs in the e2e setup (join home
  over raw WS / warp first, as disembark.spec.ts does).
- No time to run the full `npm run test` matrix or the 6-spec e2e regression this iteration.

## How to verify
- Units: `cd app && npx vitest run src/client/input/flight-loop.test.ts` → 8 pass (5 new under
  `docked undock contract (TASK-86)`). The pad-docked W test is the contract: `thrust 1`,
  `seq 1` while `docked: true, regime 'surface'`.
- tsc: `cd app && npx tsc --noEmit` → clean.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/undock.
  spec.ts` → home-dock green now; pad-dock pending the 409 fix above.
- Invariant spot-check: `anyFlightDemand` + `dockedFlightScheme` in flight-loop.ts are the only
  new exports; `main.tsx` reads demand through `dockedFlightScheme` ONLY while
  `wireDockedIndicator()` (idle frames while docked still send nothing).
