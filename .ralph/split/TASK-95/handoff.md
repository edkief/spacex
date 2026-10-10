# TASK-95 handoff — Full touch loop e2e (SC-1 by touch) + controls docs

## Status

TASK-95.1 is at the final gate: the warp-leg flake is fixed and the land-leg
diagnosis is COMPLETE with the fix applied — but the full spec run did not fit
the iteration's time budget. Next step is a single ~6-min spec run, legs 6–10
iteration if needed, then close.

## VTOL non-engagement — ROOT-CAUSED (diagnosis closed)

Run 7's wire tap (`__TLIN__` outbound input frames) + the scheme-swap console
log proved:

- The client scheme was NOT stale: swaps logged `space → atmosphere` (the
  teleport) and `atmosphere → surface` (touchdown). main.tsx's regime wiring
  is correct.
- The client DID send `action:"vtol"` frames on the wire (seq 201–203) once
  the VTOL channel went on.
- The vtol frames STOPPED ~150 ms later — exactly when the ship grounded and
  the regime flipped `surface`: idle frames to the 25 s timeout, the ship
  stranded grounded at dist 23 m / speed 0.

Root cause: `TouchControls.tsx`'s regime-flip channel hygiene (the
`prevRegimeRef` effect) ran `source.clear()` on ENTERING THE SURFACE — wiping
the held VTOL at touchdown, the one moment the lift is needed. A keyboard
player's held Space key survives the flip (the keyboard `pressed` set is
independent of the touch source), so touch was asymmetric: the lift was cut at
touchdown and the ship could never settle. This also explains the old facePad
dead end (all touch channels died at the flip).

Fix (committed): `TouchControls.tsx` — entering the surface now clears
channels only when `onFoot` (disembarded); the in-ship touchdown KEEPS the
held VTOL (the flight loop reads it through `dockedFlightScheme('surface')`;
the 1.35·g lift + pad machine settle the ship). Disembark / re-entry (the
`onFoot` flip) still clears, so the ` ` collision can't leak into the on-foot
JUMP. 2 new regression tests in `TouchControls.test.tsx` (80/80 touch tests
green, tsc green).

## Land-leg retuning (spec side)

The unit test's 100 m start does not transfer: this seed's planet is DENSER
than the test's (measured run 7: an 85 m start dead-sticks ~61 m of
horizontal travel from 90 u/s → grounds ~23 m out, just outside the disc; a
100 m start would ground ~39 m out). Spec changes (committed):

- `LAND_START_DIST_M` 85 → **75** → grounds ~13–14 m out (INSIDE the 20 m
  disc), where the pad machine docks on position/speed alone.
- VTOL switch `dist ≤ 25` → **`dist ≤ 15`** (over the disc): the server
  assist (×0.5/tick on drift, up > 0) damps the drift IN PLACE — switching
  outside the disc would freeze the ship just short of the pad. Mirrors the
  unit test's effective switch (its `alt < 2` gate only arms ~13 m out).
- After the dock: `touch(page, 'clear')` — the pilot releases the lift (also
  prevents ` ` → JUMP leaking on the egress).

## Done (committed)

- `app/tests/e2e/touch-loop.spec.ts` — warp force-click (step 1, with the
  z-index/DOM-order comment); `__TLIN__` outbound input-frame tap in
  `tapShipUpdates` (KEPT — small, commented, permanent diagnostic); vtol-switch
  + timeout wire-frame logging; scheme-swap console capture (diagnostic);
  land-leg retuning (above). tsc green.
- `app/src/client/ui/touch/TouchControls.tsx` — the in-ship touchdown VTOL fix
  (the ONE product change; client-local touch wiring).
- `app/src/client/ui/touch/TouchControls.test.tsx` — 2 regression tests.
- NO server / wire / prediction / golden-fixture changes. NO facePad /
  steering. NO main.tsx changes (its wiring was proven correct).

## Next steps (in order)

1. `cd app && npx playwright test touch-loop.spec.ts --config
   playwright.e2e.config.ts --reporter=line` (~6 min; the e2eServer fixture
   boots its own dev server — NEVER alongside `npm run dev`). Expected: warp +
   space legs green (the force-click survived run 7), land leg DOCKED
   (vtol-held-at-dock=true), and legs 6–10 executing for the FIRST time —
   expect first-touch issues there (walkUntilPrompt is verbatim from the green
   touch-onfoot spec; egress uses the committed interactPress path).
2. If legs 6–10 are red: iterate SPEC-SIDE only (timeouts, prompt strings,
   walk bursts, settles). If a leg reveals a real product bug: stop, record it
   here, do NOT silently special-case around it.
3. Green bar: the WHOLE spec in ONE run + `assertClean()` + the screenshot
   `.ralph/screenshots/TASK-95-1.png` rewritten at the sold/dock state + CAPTURE
   the `[TASK-95] loop wall=…s` console line (TASK-95.2 records it in the LOG
   entry; put it in the commit message too).
4. `cd app && npx tsc --noEmit` green; one wip commit of only the task's files:
   `wip(TASK-95): touch-loop e2e fully green (warp force-click; land leg =
   TouchControls in-ship VTOL fix + 75 m/15 m retune; legs 6-10; loop wall=…s)`.
   Then TASK-95.2 (docs + full gate + close-out).

## Dead ends (from the parent handoff — still true)

- facePad steering after the atmosphere teleport — RESOLVED BY DESIGN (the
  land leg does no steering); the true cause is now known (the flip-clear
  above) and fixed. Do NOT resurrect facePad.
- 60 m straight drop onto the pad — instant re-dock hides the atmosphere
  regime. 300 m / 150 m with thrust — the atmosphere has no thruster.
