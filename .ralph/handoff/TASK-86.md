# TASK-86 handoff — Undock fix: a docked ship has no way to take off

## Status
Client root cause fixed (committed `e252fc1`) + the e2e 409 root-caused and fixed
(this iteration, uncommitted). Remaining: ONE open design decision (DECIDE
emitted) — v1 physics cannot lift a ship off a pad by player input
(`VTOL_LIFT = GRAVITY` = neutral buoyancy). Home-dock takeoff is fully green.
After the decision: land the chosen option, run the full verification matrix,
close out (flags + LOG + commit, delete this handoff).

## Done
- **Root cause (step 1, confirmed by reading + a red unit test):** a PAD-docked
  ship carries wire regime `docked` AND `flightRegime: 'surface'`. The client
  regime tracker snapped the active regime to `surface`, which remaps keys to
  the CHARACTER scheme (`thrust: null`), so W read as a zero flight demand and
  the TASK-78 dock gate suppressed the frame — the server's "first input =
  take-off" never fired. Fixed client-side (3 files, committed `e252fc1`):
  `readSchemeInput` extracted in `controls.ts`; `anyFlightDemand` +
  `dockedFlightScheme` in `flight-loop.ts`; `main.tsx` reads demand through
  `dockedFlightScheme` ONLY while `wireDockedIndicator()`. 5 unit tests green
  in `flight-loop.test.ts` (`docked undock contract (TASK-86)`).
- **E2E 409 root-caused + fixed (this iteration):** `/api/dev/teleport`
  resolves the shard by the ship ROW's `position.systemId`
  (`dev.ts:231` `router.active(ship.position.systemId)`). A browser boot
  straight into `?sys=<padSystem>` joins the pad shard via `enter()` →
  `adoptEntity`, which does NOT persist `position.systemId` — only `warp`
  writes it (`router.ts` warp: "the ship row is written to the target first").
  So the row pointed at home, whose shard was not active → 409
  `not-in-system`. Fix = the disembark.spec.ts pattern: raw-WS join home →
  warp to the pad system → teleport. Applied in BOTH specs:
  - `app/tests/e2e/undock.spec.ts` — new `dockAtPad()` helper (raw WS
    join-home + warp + teleport + server-authoritative docked poll), pad test
    docks BEFORE the browser boots.
  - `app/tests/e2e/docked-indicator.spec.ts` — SAME fix; it was RED with the
    identical 409 (pre-existing, unrelated to the input fix — confirmed by
    root cause). NOW GREEN (6.8 s).
- **Verified (this iteration):** `undock.spec.ts` HOME-DOCK test GREEN
  (6.5 s: spawn docked → W → undock + move >5 u); `docked-indicator.spec.ts`
  GREEN. Pad-dock test now gets PAST the 409 (teleport 200, docked indicator
  visible, idle-frozen 2 s passes) and fails at the takeoff assertion — see
  DECIDE below.

## THE DECIDE (emitted, answer pending)
**The v1 flight model cannot climb off the ground.** `flight.ts`:
`VTOL_LIFT = GRAVITY` (doc: "full VTOL demand makes the ship neutrally
buoyant, so hover converges to vel.y = 0"); `integrateStep`'s
atmosphere/surface branch has NO thrust channel (thrust is space-only,
line 330) — only drag + gravity + VTOL lift. A pad-docked ship: first input
clears `entity.docked` (verified via diagnostic: the client frame now reaches
the server — the TASK-86 client bug IS fixed), but the ship can't generate
`|vel.y| ≥ 1` (`ONPAD_VERTICAL_THRESHOLD`), so `integrateShip`'s `onPad`
stays set AND the pad machine re-docks (`wasDocked` branch: on disc,
surface, slow) — wire regime `docked || onPad || padId` (shard.ts:4233) stays
'docked' forever. `shard.pads.test.ts` documents it: "the v1 atmosphere model
cannot climb on VTOL alone (VTOL exactly cancels gravity), so the climb is a
scripted state — vel.y = 5 u/s injected". Options on the table:
- (A) VTOL climb margin in shared physics (`VTOL_LIFT = 1.35 × GRAVITY`
  or similar): full VTOL climbs → real takeoff; ripples: flight.test.ts
  hover-convergence test, pads-test scripted-takeoff comment, flight feel
  (Space = throttle-up climb, no hover).
- (B) physics untouched: close TASK-86 on the client fix; pad e2e proves the
  first real input frame reaches the server (the actual defect); home-dock
  e2e proves full takeoff; pad re-dock documented as v1 behavior.

## Working tree
UNCOMMITTED (ready to commit together with this handoff):
- `app/tests/e2e/undock.spec.ts` (M — dockAtPad 409 fix)
- `app/tests/e2e/docked-indicator.spec.ts` (M — same 409 fix, now green)
- `.ralph/handoff/TASK-86.md` (this file)

NOT mine — leave alone (pre-existing dirty): `.gitignore`, `.ralph/tasks.json`,
`ralph.config.json`, `?? .gitattributes`, `?? .ralph/ESCALATION.md`,
`?? .ralph/logs/t761/`, `?? .ralph/logs/t83/`, `?? .ralph/tasks/TASK-86.json`,
`?? .ralph/tasks/TASK-87.json`, `?? .ralph/tasks/TASK-88.json`, all
`M .ralph/screenshots/*.png` (do NOT commit per task note).
Committed in `e252fc1`: the 4-file client fix + `flight-loop.test.ts` +
original `undock.spec.ts`.

## Next steps
1. Read the DECIDE answer.
   - (A): change `VTOL_LIFT` in `app/src/shared/physics/flight.ts` (+ doc
     comment), update flight.test.ts hover expectations + pads-test comment,
     re-verify client/server parity is automatic (shared module), keep the
     pad e2e as-is (it should then pass with Space held — note: the pad test
     currently holds W; with (A) W alone still won't climb (thrust is
     space-only) — the pad test must hold ' ' (VTOL) and assert regime
     leaves docked + moves; update the test accordingly).
   - (B): rework the pad test to assert the client-fix contract (frame sent +
     server freeze cleared — observable proxy: the wire stops being frozen /
     the frame tap shows seq ≥ 1 reaching the server), document the pad
     re-dock as v1 behavior in the spec header.
2. Full verification: `cd app && npx tsc --noEmit`; `npm run test`; e2e
   `undock.spec.ts` + `docked-indicator.spec.ts` + `disembark.spec.ts` +
   `enter-ship.spec.ts` + `flight.spec.ts` + `core-flow.spec.ts` via
   `npx playwright test --config playwright.e2e.config.ts <files>`;
   `eslint --fix` + `prettier --write` on all touched files.
3. Close out: `passes: true` for TASK-86 in `.ralph/tasks.json` + all 4 steps
   `pass: true` in `.ralph/tasks/TASK-86.json`; LOG.md entry at top (date,
   summary, screenshot path); commit `fix(TASK-86): ...`; delete this handoff.

## How to verify
- Units: `cd app && npx vitest run src/client/input/flight-loop.test.ts` →
  8 pass (5 new under `docked undock contract (TASK-86)`).
- tsc: `cd app && npx tsc --noEmit` → clean (verified at `e252fc1`).
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts
  tests/e2e/undock.spec.ts tests/e2e/docked-indicator.spec.ts` → home-dock +
  docked-indicator green now; pad-dock pending the DECIDE.
- Diagnostic that proved the client fix (deleted after use): raw-WS tap of
  the browser's WS showed the client SENDING input frames while W was held
  (probe stepped at 20 Hz) and the server re-docking the at-rest ship
  (wire regime stayed 'docked', pos frozen) — i.e. first-input-undock fires,
  pad machine re-docks, physics can't climb.

## Dead ends
- Holding W on a pad-docked ship does NOT take it off in v1 physics — NOT a
  client bug (the frame reaches the server; `entity.docked` clears). Do NOT
  "fix" this by touching the flight loop, the dock gate, the pad machine, or
  the server dock code: the gap is `VTOL_LIFT = GRAVITY` (neutral buoyancy) +
  no thrust channel in atmosphere/surface. It is a design decision (DECIDE
  emitted), not an implementation detail.
- Teleporting the ship directly onto the pad surface (y = pad.y) works for
  docking, but y+5 (disembark pattern) is the proven approach — keep it.
- The `#docked-indicator` offsetParent check is UNRELIABLE (fixed positioning
  → offsetParent null even when visible); assert via Playwright locators,
  not offsetParent.

## Decisions

A person, or the escalation agent in their place, answered these questions
and left these notes, latest last (`.ralph/decisions.jsonl`). They are
decided: follow them where they apply, over the spec where the two disagree,
and do not ask again.

- (none recorded for TASK-86 yet)
