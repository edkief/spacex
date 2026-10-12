# TASK-108 Handoff — Boost toggle: Shift toggles cruise boost

## Status
Implementation is complete and verified: unit tests green, `tsc --noEmit` green, and the new
e2e `boost-toggle.spec.ts` PASSES (one Shift tap sustains the cruise: 5 s hold min speed 400 u/s
with no keys held; decay to ≤121 in 5.6 s; legacy W+Shift press-hold verified store-untouched).
Remaining is verification bookkeeping only (full suite re-run, one flaky e2e re-run, lint/format,
passes flag, LOG entry, final feat commit).

## Done
All spec steps implemented (client-only, zero server/protocol/physics change):

- **New** `app/src/client/state/boost.ts` — the boost toggle store (hover.ts shape:
  subscribe/emit-on-change, `boostOn`/`setBoostOn`/`toggleBoost`/`boostOnSubscribe`, pure
  predicates `boostAllowed(regime, onFoot)` = `!onFoot && regime === 'space'`,
  `boostAutoDisengage` = its negation, `__resetBoost` test seam).
- **New** `app/src/client/boost-debug.ts` — `window.__BOOST__` dev probe (hover-debug.ts shape,
  `on` getter + `toggle` + `set`), installed from main.tsx.
- **New** `app/src/client/state/boost.test.ts` — store idiom, regime gating, auto-disengage
  (the exact main.tsx expression), and the flight-loop payload composition tests
  (toggle on ⇒ 'boost' tag with no keys; off ⇒ byte-identical legacy; store off + Shift held ⇒
  tag; regime→atmosphere ⇒ force-off).
- `app/src/client/main.tsx` — 4 edits:
  1. imports (boost store + `installBoostDebug` + `isBoostTap`).
  2. entity_update handler: boost AUTO-DISENGAGE — `if (self &&
     boostAutoDisengage(regimeWiring.regime, self.kind === 'character')) setBoostOn(false)`
     (mirrors the TASK-107 hover line right above it).
  3. **Shift tap/press-hold effect** (mirrors the Space-hover effect): keydown arms `downAt`
     (only when `flightLoopScheme(regime, wireDocked).boost === 'Shift'`, not typing, no surface
     open, not e.repeat); **keyup toggles ONLY if held < `BOOST_TAP_MAX_MS` (200 ms)** — a longer
     press is the legacy press-hold (store never touched); blur drops the arm.
  4. flight loop: `if (boostOn()) input.boost = 1;` right after the hover override (the store
     rides the existing `withButtons.boost` composition; the CRUISE `setCruiseState` line reads
     the merged input, so it now follows the toggle automatically). `installBoostDebug()` at
     module bottom next to `installHoverDebug()`.
- `app/src/client/input/flight-loop.ts` — `BOOST_TAP_MAX_MS = 200` + pure `isBoostTap(heldMs)`
  (exported, unit-tested).
- `app/src/client/ui/ship-hud/ship-hud.tsx` — `CruiseTag` gains a `regime` prop and is hidden in
  any non-space regime (`!state.held || regime !== 'space'`) — the store auto-offers off-space,
  the gate keeps the tag honest in the 10 Hz gap. `state.held` already follows the toggle via
  the merged flight-loop input (no other HUD change needed).
- `app/src/client/ui/touch/TouchControls.tsx` — the BOOST button is now a TOGGLE:
  `pressed={boost}` (live `boostOnSubscribe` state), `onPress={() => toggleBoost()}`,
  `onRelease={() => {}}` — drives the store directly, does NOT write the 'Shift' virtual key
  (exactly like the VTOL/hover button from TASK-107). aria-pressed mirrors the store.
- **New** `app/tests/e2e/boost-toggle.spec.ts` — 4 phases: (A) one Shift tap (no hold) at the
  home-dock space spawn: `__BOOST__` on, CRUISE tag lit, wire undocks on the first boost frame;
  (B) deep-space teleport (10 770 u from the nearest anchor — clearance-safe), W to >300 u/s,
  release W, assert speed stays >100 u/s for a full 5 s with NO keys held; screenshot
  `.ralph/screenshots/TASK-108-1.png` with CRUISE lit (verified: 376 m/s, SPACE + CRUISE tags);
  (C) second Shift tap: `__BOOST__` off, tag hidden, speed decays ≤121 (SOFT_CAP_DECAY, measured
  5.6 s); (D) long W+Shift press (>200 ms) boosts past 121 with the store staying OFF (legacy
  press-hold path + tap discrimination).
- Updated unit tests: `ship-hud.test.tsx` (cruise tag: follows the toggle + hidden in
  atmosphere/surface even if state is on), `TouchControls.test.tsx` (BOOST button toggle tests:
  tap flips store, release no-op, no virtual-key write, live subscribe; channel-hygiene tests
  re-pointed at the legacy press-hold channel via `source.setChannel`), `flight-loop.test.ts`
  (tap vs press-hold + scheme-guard tests).
- Verified this session: `npx tsc --noEmit` green; touched unit files 114/114 green; full
  `npm run test` 201/202 files green (see Dead ends for the one flaky file); e2e batch
  `boost-toggle + cruise + flight + vtol-hover + touch-flight + touch-padded` = 5 passed,
  `atmospheric-flight` failed once (see Dead ends).

## Working tree
- **Uncommitted** (all of it is this task; nothing else of mine):
  - new: `app/src/client/state/boost.ts`, `app/src/client/state/boost.test.ts`,
    `app/src/client/boost-debug.ts`, `app/tests/e2e/boost-toggle.spec.ts`,
    `.ralph/screenshots/TASK-108-1.png`, this handoff.
  - modified: `app/src/client/main.tsx`, `app/src/client/input/flight-loop.ts` (+test),
    `app/src/client/ui/ship-hud/ship-hud.tsx` (+test), `app/src/client/ui/touch/TouchControls.tsx`
    (+test).
- Unrelated dirty files from other sessions (`.gitignore`, `.ralph/prd/PRD.md`, many
  `.ralph/screenshots/*.png`, `ralph.config.json`, untracked `.ralph/tasks/TASK-1xx.json` etc.)
  — leave them alone; commit ONLY the files listed above.
- Builds: tsc green; unit green; e2e boost-toggle green. Dev server was killed at handoff.

## Next steps
1. `cd app && npm run test` (full suite, ~2.5 min) — expect green (the abuse.spec.ts flake
   passes standalone; re-run the file if it flakes again).
2. `npx playwright test --config playwright.e2e.config.ts atmospheric-flight.spec.ts` —
   re-run the once-failed spec to confirm it's a flake (see Dead ends).
3. Re-run the task's e2e set if anything above was re-run:
   `npx playwright test --config playwright.e2e.config.ts boost-toggle.spec.ts flight.spec.ts cruise.spec.ts`.
4. `npx tsc --noEmit` (last check) and `eslint --fix` + `prettier --write` on the touched files.
5. Bookkeeping: set the step pass flags in `.ralph/tasks/TASK-108.json`, `"passes": true` for
   TASK-108 in `.ralph/tasks.json`, LOG.md entry (top; mention 5 s hold 400 u/s no-keys, decay
   5.6 s, screenshot path), delete this handoff.
6. Commit the listed files (not the unrelated dirty ones):
   `feat(TASK-108): boost toggle (Shift + touch + HUD)`, then output the promise.

## Dead ends
- **Keydown-only toggle (first implementation)**: a Shift *press* flipped the store. This broke
  the spec edge case ("toggle off + Shift physically held keeps legacy press-hold") and made
  e2e phase D fail — the release of the long press then toggled the store on. Fixed by moving
  the flip to **keyup with held-time < 200 ms** (`isBoostTap`); e2e green after the fix.
- **Phase D originally pressed Shift alone**: boost only raises the effective cap/acceleration —
  the *force* comes from thrust, so Shift alone (no W) never accelerates (speed just decayed
  from the prior cruise and never crossed 121). The legacy combo is **W+Shift** (as in the
  original TASK-85 cruise.spec.ts). Fixed the test; keep it that way.
- `tests/abuse/abuse.spec.ts` failed 2 tests (timeouts) once under full-suite load, then passed
  8/8 standalone — pre-existing load flake, not caused by this change (the change is client
  input-state only; the abuse spec drives the server directly).
- `atmospheric-flight.spec.ts` ("VTOL climb to space") failed once in the 6-spec regression
  batch, with cruise/flight/vtol-hover/touch-flight/touch-padded all passing. This change does
  not touch VTOL/hover/physics — treat as a flake and re-run standalone to confirm.
- `/tmp/opencode` is NOT writable in this environment (background log redirect failed with
  "Permission denied") — use `/workspace/master` paths for any log files.

## How to verify
- `cd app && npx tsc --noEmit`
- `cd app && npm run test` (full unit suite)
- Start `npm run dev` (background, app dir; health at http://localhost:3000/api/health), then:
  `cd app && npx playwright test --config playwright.e2e.config.ts boost-toggle.spec.ts`
  (expect ~35 s, log line `5s-hold min speed=… u/s (no keys held)`; CRUISE lit in
  `.ralph/screenshots/TASK-108-1.png`), plus `flight.spec.ts cruise.spec.ts vtol-hover.spec.ts
  touch-flight.spec.ts touch-padded.spec.ts atmospheric-flight.spec.ts` as the regression set.
- Manual sanity: in space, one quick Shift tap lights CRUISE and sustains boost with no keys
  held; a held Shift (>200 ms) never lights the tag via the store and ends with the key.
