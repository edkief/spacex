# Handoff: TASK-53

## Status

TASK-53 is fully IMPLEMENTED and VERIFIED — implementation, all unit tests, the
e2e spec, and every regression gate are green. What remains is close-out
bookkeeping only (set the 4 step flags in `.ralph/tasks/TASK-53.json`,
`passes: true` in `.ralph/tasks.json`, LOG.md entry + counter bump, delete this
handoff file, one commit). The previous session's handoff (menu shell + panel
build) was picked up and completed; its "Next steps" are all done.

## Done

All committed across these commits (newest first):

- `wip(TASK-53): menu e2e spec + lint/prettier cleanup` (this commit) —
  `app/tests/e2e/menu.spec.ts` (NEW, green 11.1 s), prettier formatting on
  `main.tsx` / `menu.test.ts` / `esc-menu.test.tsx` / `ship-panel.tsx` /
  `ship-panel.test.tsx`, removed a stale `eslint-disable react-hooks/
  exhaustive-deps` comment in `ship-panel.tsx` (rule not installed — it was a
  lint error), test-import fix in `ship-panel.test.tsx` (`PanelContext` comes
  from `@client/state/menu`, not `./ship-panel`), regenerated screenshots
  (TASK-53-1/2 new; TASK-7/39/40 screenshots refreshed by regression runs).
- `test(TASK-53): menu stack + ship panel ... + esc menu + focus trap unit
  tests; tab onClick fix` — the 4 unit test files (33 tests) + the missing
  `onClick={() => setTab(t)}` on the ShipPanel tab buttons (a gap in the WIP
  commit — tabs switched by arrow keys but not by click).
- `wip(TASK-53): main.tsx integration ...` — the full main.tsx wiring.
- `4b3186c wip(TASK-53): menu stack + focus trap + ESC menu + ONE shared
  ship/dock panel ...` — the pre-existing components.

The main.tsx integration (all in `app/src/client/main.tsx`):
- `state/menu.ts` stack is the single modal source of truth; `stack` state via
  `menuSubscribe(setStack)`. Derived: `anyOpen`, `menuOpen`, `chartOpen`,
  `panel` (the PanelSurface).
- Global keydown effect: ESC pops the top surface (closing the cargo/dock
  store alongside via `closePoppedPanel`); ESC from empty stack opens the menu
  (`openMenu()`); M opens/closes the chart through the stack (swallowed while
  a menu/panel is on top).
- Input gating: `anySurfaceOpen()` guards E (leave-ship/interact), Q (drop),
  T (target lock), 1/2 (weapon), LMB fire, and the shared pressed-key
  capture (so the prediction loops get zero demand); a menuSubscribe effect
  clears `pressedRef` when any surface opens. `effectiveFlightPressed` still
  receives `chartOpen` for the old flight-loop tests.
- `ui-open {ui:'dock'}` and the `'cargo'` frame now ALSO call `openPanel(...)`
  (dock-panel/sell, cargo-panel/context-from-`dockedIndicator()`).
- Panel ship view: `updatePanelShip(entity)` converts the wire's NORMALIZED
  hull/shields (0..1) to absolute points against the class caps, keeps energy
  + livery (via `panelLiveryFromWire` — the wire livery is an open
  `Record<string,string>`, the panel wants the strict 3-slot `Livery`);
  canonicalJson-gated. Fed from all three self-entity bridge paths.
- Actions: `sendCargoTransfer`, `doLivery` (POST /api/ships/livery,
  `{colors}`), `doRepair` (POST /api/ships/repair → `setCredits` on success
  balance, transient `repairMessage` on failure).
- Renders: `#surface-backdrop` (z 110) while any surface is open; `StarChart`
  driven by the stack (`onClose={closeTopSurface}`); `EscMenu` (callsign,
  credits store, resume/systems/ships callbacks — Systems = `openChart()`,
  Ships = `openPanel({id:'ship-panel', context: docked?'docked':'flight',
  activeTab:'overview'})`); the menu's `#ship-panel` (Overview; hold is null —
  the 'cargo' frame is the only hold source); re-shelled `CargoPanel` /
  `DockPanel` with the new props.

## Working tree

Clean after this handoff commit. Builds: `npx tsc --noEmit` clean,
`npm run test` green (162 files, 1486 passed / 1 skipped), eslint + prettier
clean on all touched files.

## Next steps

Close-out only, in order (no code changes expected):
1. Set the 4 steps `pass: true` in `.ralph/tasks/TASK-53.json` (all four
   verified: 1 menu shell + input gating, 2 shared ship panel, 3 dock panel,
   4 tests + e2e).
2. Set `"passes": true` for TASK-53 in `.ralph/tasks.json` (entry at line ~593).
3. `.ralph/logs/LOG.md`: new entry at the top (date 2026-10-04, summary: menu
   stack store + ESC menu + ONE shared ShipPanel with context-driven tabs +
   livery debounce + repair gating, main.tsx integration with modal input
   gating, 33 new unit tests, e2e menu.spec.ts; screenshots
   `.ralph/screenshots/TASK-53-1.png` (menu open over docked cockpit) +
   `TASK-53-2.png` (on-foot SHIPS panel); verify line: tsc clean, 162 files /
   1486 passed / 1 skipped, e2e menu 11.1 s + star-chart/cargo/sell
   regressions green) and bump `Tasks Completed` 75 → 76, update
   `Current Task`.
4. Delete `.ralph/handoff/TASK-53.md`.
5. Conventional-commit it (e.g. `feat(TASK-53): menu shell — ESC menu, chart,
   shared ship/dock panel; close-out`).

If anything looks off on re-check, the gates are listed in "How to verify"
below. No dead ends are expected to bite.

## Dead ends

None new. One historical note: `star-chart.tsx` no longer handles Escape
itself (moved to the menu stack) — do not re-add it; `tests/e2e/
star-chart.spec.ts` (M open, ESC close) still passes against the stack
handler.

## How to verify

- Unit: `cd app && npm run test` (162 files / 1486 passed / 1 skipped at
  close-out). New files: `src/client/state/menu.test.ts` (9),
  `src/client/ui/ship-panel.test.tsx` (13 — tab sets, click/arrow switching,
  repair gating, livery 5→1 debounce with fake timers, livery-echo draft
  reset), `src/client/ui/esc-menu.test.tsx` (5),
  `src/client/ui/focus-trap.test.tsx` (5).
- Typecheck: `cd app && npx tsc --noEmit`.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts
  tests/e2e/menu.spec.ts` (green 11.1 s — claim → pad-teleport → docked boot
  → ESC menu with items/footer → M/E suppressed while open → Systems opens
  chart on top → ESC backs out chart→menu→closed → E disembarks (suppression
  transient) → on-foot ESC → SHIPS opens `#ship-panel` → ArrowRight to Cargo
  → ESC pops back to menu). Screenshots written to
  `.ralph/screenshots/TASK-53-{1,2}.png`.
- Regressions (all green): `star-chart.spec.ts` (4.9 s), `cargo.spec.ts`
  (10.8 s — its Escape-close + E-disembark paths now run through the menu
  stack), `sell.spec.ts` (12.8 s — dock panel opens via the stack).
- DOM contracts preserved: `#cargo-panel`, `#dock-panel`, `#star-chart`,
  all `move 1/all <res>` and `sell 1/all <res> <source>` aria-labels,
  `weight N of M` labels.
