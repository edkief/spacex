# TASK-91 handoff

## Status

TASK-91 is ~95% complete: all code, unit tests, and the e2e spec are written, and the full
verification chain ran green in this session (tsc, eslint/prettier, 1819 unit tests, and the
new `touch-flight.spec.ts` e2e — 32.2 s, all four legs server-confirmed). The only remaining
work is a small close-out: one uncommitted UI polish (button moved from the left edge to the
right edge because it overlapped the player list) needs a single e2e re-run to re-verify +
refresh the screenshot, then the bookkeeping (task flags, LOG.md, commit).

## Done

All committed state is at `c6aaf32` (TASK-90). My TASK-91 work is UNCOMMITTED (see Working tree):

- `app/src/client/input/touch.ts` — added `TouchInputSource.snapshot()` (copy of active
  channels; the debug hook + unit tests read it).
- `app/src/client/input/touch.test.ts` — new test for `snapshot()`.
- `app/src/client/touch-debug.ts` — NEW: dev-only hook, `installTouchDebug()` →
  `window.__TOUCH__` with live `channels` getter + `setChannel`/`clear` passthrough (delegates
  to a lazily-bound source via `bindTouchDebug(state, getSource)`). Same pattern as
  interact-debug.ts. No-op in production (`import.meta.env.DEV` gate).
- `app/src/client/ui/touch/TouchControls.tsx` — NEW: the flight layout container.
  - `enabled: false` → renders nothing + clears all channels (effect).
  - `regime === 'surface'` → renders nothing + clears all channels (TASK-93 owns it).
  - LEFT stick `onChange({x,y}) → source.setChannel({ thrust: y, yaw: x })`;
    RIGHT stick `→ { pitch: y, roll: x }` (up-positive, per spec).
  - VTOL `TouchButton` only in atmosphere (`vtol: true/false`), BOOST only in space
    (`boost: true/false`) — mirrors the ControlScheme.
  - Regime-flip effect clears the outgoing regime's button channel (unmounted button never
    fires onRelease) — deliberately does NOT write on initial mount (prev-regime ref guard).
  - Corner positioning: `CORNER = 24` px + `env(safe-area-inset-*)`; theme tokens via the
    child widgets; sticks at bottom-left/bottom-right, the per-regime button above the RIGHT
    stick (see Dead ends for why it's on the right).
- `app/src/client/ui/touch/TouchJoystick.tsx` — `joystickVector` now canonicalizes zero
  components to +0 (a horizontal drag passed `-0` through the y-flip; `Object.is(-0, 0)` is
  false — same rule as `flip` in controls.ts). Caught by the new unit tests.
- `app/src/client/main.tsx` — imports `TouchControls` + the touch-debug hook; `touchEnabled`
  state = `navigator.maxTouchPoints > 0` (v1 gate; TASK-94 replaces with the real flag);
  `bindTouchDebug(touchDebug, () => touchRef.current)` in an effect; renders
  `<TouchControls enabled={touchEnabled} regime={regimeWiring.regime} source={touchRef.current} />`
  right after `<HudRoot>`. `touchDebug` const installed next to the other dev hooks at file
  bottom. Ship loop / schemes / wire mapping untouched (AC).
- `app/src/client/ui/touch/TouchControls.test.tsx` — NEW, 14 tests: layout per regime,
  disabled/surface render nothing, stick→channel mapping (up-positive), button press/release,
  channel hygiene on regime flip / disable / unmount, touchDebug passthrough + live snapshot.
- `app/tests/e2e/touch-flight.spec.ts` — NEW, single test, GREEN (32.2 s): touch-emulated
  context (`hasTouch: true` → `maxTouchPoints = 1`, verified empirically), claims a player
  whose home system has a landable atmospheric planet (REST-only claim loop, planet-approach
  pattern), then: (1) space layout assertion (both sticks + BOOST label, no VTOL),
  (2) `__TOUCH__.setChannel({thrust:1})` → server speed rises (8 → 96 u/s), screenshot
  `.ralph/screenshots/TASK-91-1.png`, (3) teleport to DEEP_SPACE `{x:0,y:50,z:4000}` +
  `{thrust:1,boost:1}` → cruise-top 360 u/s, release → decayed to ≤ 121, (4) yaw=+1 2 s →
  dot(forward, initialRight) = 0.977 > 0.2 (TASK-80 convention), (5) teleport into the home
  planet's band (anchor.x+700, y 400) → wire regime 'atmosphere', VTOL button visible,
  (6) `vtol:1` → server vel.y 9.8 u/s, altitude 394 → 401.

Verified in this session: `npx tsc --noEmit` clean; `eslint --fix` + `prettier --write` clean
on all touched files; full `npm run test` → 196 files, 1819 passed / 1 skipped;
`npx playwright test -c playwright.e2e.config.ts tests/e2e/touch-flight.spec.ts` → 1 passed.

## Working tree

UNCOMMITTED (all of my work, on top of `c6aaf32`):
- `app/src/client/input/touch.ts` (M), `app/src/client/input/touch.test.ts` (M)
- `app/src/client/main.tsx` (M), `app/src/client/ui/touch/TouchJoystick.tsx` (M)
- `app/src/client/touch-debug.ts` (new), `app/src/client/ui/touch/TouchControls.tsx` (new),
  `app/src/client/ui/touch/TouchControls.test.tsx` (new), `app/tests/e2e/touch-flight.spec.ts` (new)
- `.ralph/screenshots/TASK-91-1.png` (new — from the green e2e run)

Everything else dirty in `git status` (`.gitignore`, `.ralph/prd/PRD.md`, `ralph.config.json`,
the ~50 re-encoded screenshot files, `app/.ralph/`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`,
`.ralph/logs/t83/`, `?.ralph/tasks/TASK-89..95.json`, `.gitattributes`) is PRE-EXISTING dirt —
do NOT commit it; stage only the files above + the handoff.

Builds green as of the last check (tsc/eslint/prettier/unit/e2e all passed AFTER every edit
EXCEPT the final button-move edit — see Next steps).

## Next steps

1. The last edit of this session moved the per-regime button from above the LEFT stick to
   above the RIGHT stick (in `TouchControls.tsx`, `left:` → `right:` on the
   `#touch-btn-vtol`/`#touch-btn-boost` wrapper) because in the screenshot it overlapped the
   player list panel on the left edge. This edit is NOT yet e2e-verified.
2. Re-run the spec (dev server is NOT running — the harness boots its own):
   `cd app && npx playwright test -c playwright.e2e.config.ts tests/e2e/touch-flight.spec.ts`
   — expect green ~45 s; it rewrites `.ralph/screenshots/TASK-91-1.png` with the new layout.
   Visually check the screenshot: sticks bottom-left/bottom-right, BOOST button above the
   right stick, no overlap with HUD panels. (Minor, pre-existing-ish: the player list text
   grazes the top of the left stick; the spec only asks to keep the overlay out of the ship
   HUD (top-left SHLD/HULL/SPD panel) and the fire path — both clear.)
3. Optional quick re-check: `cd app && npx tsc --noEmit && npm run test` (unit ~2.5 min).
4. Bookkeeping: set both step `pass: true` flags in `.ralph/tasks/TASK-91.json`; set
   `"passes": true` for TASK-91 in `.ralph/tasks.json`; add the LOG.md entry at the top
   (date, summary, numbers above, screenshot path) and bump 'Tasks Completed';
   `.ralph/STRUCTURE.md` needs NO change (`src/client/ui/touch/` already existed from
   TASK-90). No new dirs.
5. Commit ONLY the staged files (list in Working tree) as
   `feat(TASK-91): wire touch into flight (space + atmosphere): sticks + VTOL/boost`.
6. Output `<promise>TASK-91:DONE</promise>` and stop.

## Dead ends

- `expect.poll(...).then(...)` doesn't exist on Playwright poll matchers — use a promise
  returning the value you want to match (e.g. `.then(u => u?.vel.y ?? 0)` on the poll
  function) with the matcher after.
- The e2e seeds the session via REST claim + `localStorage['drift.session.v1']` only, so
  `localStorage['drift.token']` is NULL in the page — pass the claim response's `token`
  directly into the teleport helper (planet-approach pattern) instead of reading it back.
- Module-level `boundSource` in touch-debug.ts leaks across vitest tests: the "unbound"
  test must `vi.resetModules()` + dynamic import to get a fresh module instance.
- The regime-flip clear effect fires on initial mount and pollutes channel snapshots in the
  unit tests — guard with a `prevRegimeRef` (skip when prev is null).
- `navigator.maxTouchPoints > 0` is a viable v1 enablement gate: Playwright `hasTouch: true`
  → 1, default context → 0 (verified empirically with headless chromium).

## How to verify

- `cd app && npx tsc --noEmit` (clean)
- `cd app && npx vitest run src/client/ui/touch/ src/client/input/touch.test.ts` (55 tests)
- `cd app && npm run test` (full: 196 files / 1819 passed / 1 skipped)
- `cd app && npx playwright test -c playwright.e2e.config.ts tests/e2e/touch-flight.spec.ts`
  (logs `[TASK-91] callsign=... thrust 8.0 → 96.0 u/s ... cruise-top=360.0 ... yaw-dot=0.977 vtol vel.y=9.8`)
- Screenshot: `.ralph/screenshots/TASK-91-1.png` (dual sticks + BOOST over the space view)
