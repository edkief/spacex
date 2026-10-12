# TASK-107 handoff — VTOL hover toggle (client half)

## Status
Implementation and e2e spec are COMPLETE and green; only the final regression gate (flight + undock/pad-approach e2e), lint/format pass, full `npm run test`, bookkeeping, and the conventional commit remain. Nothing is committed yet.

## Done
All TASK-107 code is written in the working tree:
- **NEW `app/src/client/state/hover.ts`** — client hover store (docked.ts subscribe/emit idiom, emit-on-change): `hoverAllowed`, `hoverAutoDisengage`, `setHoverOn`, `toggleHover`, `hoverOn`, `hoverOnSubscribe`, `__resetHover`.
- **NEW `app/src/client/hover-debug.ts`** — `window.__HOVER__` dev probe (`on`, `toggle`, `set`), installed by `installHoverDebug()` at module load in `main.tsx` (~line 2655), `import.meta.env.DEV` guarded.
- **`app/src/client/input/flight-loop.ts`** — new export `flightLoopScheme(regime, wireDocked)`; hover folded into `shipInputKey` / `anyFlightDemand` (hover implies up).
- **`app/src/client/main.tsx`** — Space keydown TOGGLE effect (placed after the key-capture effect, ~line 1725); hover injection in the flight loop body: `if (hoverOn()) { input.up = 1; input.hover = 1; }`; auto-disengage in the `entity_update` handler (wire regime leaves atmosphere/surface → space, or egress where self becomes character); `installHoverDebug()` call.
  - Toggle guard: `flightLoopScheme(regimeWiring.regime, wireDockedIndicator()).vtol !== ' '` → return. So Space toggles in atmosphere AND in-ship 'surface' (pad-docked/landed via `dockedFlightScheme`), and is inert in space and on foot (Space = jump there).
- **`app/src/client/ui/ship-hud/ship-hud.tsx`** — `HoverTag` rendered as `#ship-hud-hover` in the CRUISE indicator cluster; lit exactly while hover store on AND regime atmosphere/surface (same CRUISE-tag pattern).
- **`app/src/client/ui/touch/TouchControls.tsx`** — VTOL button (atmosphere slot) is now a toggle over the same store: `aria-pressed` + accent when on. Does NOT go through the virtual-key projection (so the legacy held-'vtol' e2e paths are untouched); space slot stays BOOST.
- **NEW `app/tests/e2e/vtol-hover.spec.ts`** — phases: (A) one Space press settles ship to 10 m ± 2 m within 15 s, holds 5 s (±2 m, |vel.y| < 0.5); (B) toggle-off descends to ground within 15 s; (C) `#ship-hud-hover` visible/hidden; (D) dev-teleport to space ⇒ store auto-offered (via `__HOVER__`). Screenshot written to `.ralph/screenshots/TASK-107-1.png` during phase A.
- **Tests:** NEW `app/src/client/state/hover.test.ts`; extended `ship-hud.test.tsx`, `TouchControls.test.tsx`, `flight-loop.test.ts`. Ran: 4 files / 102 tests green.
- **`npx tsc --noEmit` green** (run from `app/`).
- **`tests/e2e/vtol-hover.spec.ts` GREEN** (42.5 s): A settled in 7869 ms, B descended in 2141 ms, D auto-offered.
- Screenshot `.ralph/screenshots/TASK-107-1.png` exists (52 KB) and was viewed: ship mid-air over the green terrain, SPD 0.1 m/s, with the ATMOS + HOVER tags lit in the SPD/ALT cluster (HUD hover indicator visible during the phase-A hold).

## Working tree
- **Uncommitted:** all of the above (7 modified files + 4 new files under `app/`, plus the new screenshot).
- **Uncommitted, NOT this task (pre-existing dirty, do NOT commit):** `.gitignore`, `.ralph/prd/PRD.md`, `ralph.config.json`, ~60 old `.ralph/screenshots/TASK-*.png` rewrites, `app/.ralph/logs/`, `app/.trace-tmp/`, `.agents/skills/browser-check/`, `.gitattributes`, `.ralph/ESCALATION.md`, untracked `.ralph/tasks/TASK-*.json` files, `.ralph/logs/t761/`, `t83/`. Prior pattern (see commits for TASK-105/106): commit only the task's files.
- `.ralph/tasks.json` is NOT touched (per handoff rules, `passes` stays `false`).
- **Builds:** `npx tsc --noEmit` green in `app/`. Eslint/prettier NOT yet run on the touched files.
- Dev server was killed at handoff; the next iteration must start it: `cd app && npm run dev` (vite :3000 + tsx server :3001) in the background before running e2e.

## Next steps
1. Start dev server: `cd app && npm run dev` (background). Wait for health: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` → 200.
2. Regression gate (AC: hover-off = pre-existing pad-approach/flight specs pass unmodified):
   `cd app && npx playwright test --config playwright.e2e.config.ts flight.spec.ts undock.spec.ts`
   ("pad-approach" spec = `undock.spec.ts` — there is no pad-approach.spec.ts).
3. `cd app && npx eslint --fix <touched files> && npx prettier --write <touched files>` (touched files = the 7 modified + 4 new under `app/src`, plus `app/tests/e2e/vtol-hover.spec.ts`), then re-run `npx tsc --noEmit`.
4. Full `npm run test` in `app/` (~2 min, ~200 files). Known pre-existing load-flake family (do NOT change code for these; one isolated re-run per red): `abuse.spec.ts` WS timing, combat-hud budget, `multiplayer-foot` p95.
5. Bookkeeping: in `.ralph/tasks.json` (a JSON ARRAY — find entry by id) set `"passes": true` for TASK-107. In `.ralph/logs/LOG.md`: newest entry at top (date, summary, screenshot path, **note the intentional behavior change**: `atmospheric-flight.spec.ts` phase B "hold Space to climb out of atmosphere" will now hover at 10 m instead of leaving atmosphere — owner-requested toggle semantics; it is NOT in this task's required regression list (vtol-hover, flight, undock/pad-approach) — do not "fix" by reverting the toggle); bump "Tasks Completed" 124 → 125; update the "Current Task" line. Check STRUCTURE.md (all new files are in pre-existing dirs — likely no change).
6. Conventional commit (stage only this task's files): `feat(TASK-107): VTOL hover toggle (Space + touch + HUD)`.
7. Kill the background dev server before finishing, then output `<promise>TASK-107:DONE</promise>` and stop.

## Dead ends
- **`invalid-teleport: expected number, received null` (400) in the first e2e run:** the spec's space-teleport point was built from `planetAnchor().y`, but `planetAnchor()` returns only `{x, z}` (no `y`). Fix: base the space point on `groundA + atmoR * 1.2` (same as the server-side convention). Already fixed in the committed-to-tree spec.
- **e2e terrain sampling mismatch:** the spec's altitude reads must mirror the server `TerrainContext.heightAt` bilinear sampling EXACTLY (same seed `DRIFT-SEED-0001`, see `app/src/server/shard/terrain.ts`), not a naive grid read.
- **Do not attempt a real climb for phase D (auto-disengage):** the hover controller itself keeps the ship at 10 m, so you can never reach space while hover is on — the spec uses the dev-teleport to space instead. This is intentional.
- **Do NOT revert the Space-toggle to a hold behavior** to make `atmospheric-flight.spec.ts` phase B pass — that is the intended owner-requested behavior change; that spec is out of the required regression list.

## How to verify
- `cd app && npx tsc --noEmit` → green.
- `cd app && npx vitest run src/client/state/hover.test.ts src/client/ui/ship-hud/ship-hud.test.tsx src/client/ui/touch/TouchControls.test.tsx src/client/input/flight-loop.test.ts` → 102 tests green.
- With dev server up: `cd app && npx playwright test --config playwright.e2e.config.ts vtol-hover.spec.ts` → 42.5 s green (was green at handoff).
- Regressions: `npx playwright test --config playwright.e2e.config.ts flight.spec.ts undock.spec.ts` → expected green (NOT yet run at handoff — this is the main outstanding gate).
- Screenshot evidence: `.ralph/screenshots/TASK-107-1.png` (hover HUD tag visible, ship over terrain).
- Legacy byte-identity proof (by design, verified in review not by test): with hover off, `hoverOn()` is false ⇒ flight loop injects nothing ⇒ payloads are byte-identical to pre-task; the legacy `__TOUCH__.setChannel({vtol})` bridge, touch virtual-key ' ' projection, and keyboard key-capture paths were deliberately left untouched so touch-flight/touch-loop/touch-padded e2es keep the held-'vtol' path.
