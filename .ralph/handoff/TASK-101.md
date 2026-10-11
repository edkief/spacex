# TASK-101 handoff — Touch FIRE: hold-to-fire at the weapon cooldown

## Status
TASK-101 is functionally COMPLETE and fully verified this session — every gate green (RTL 50/50, full unit suite 197 files / 1890 passed, `tsc` clean, eslint+prettier clean, `touch-combat.spec.ts` + `touch-loop.spec.ts` e2e 2/2). Only close-out remains: flip `passes: true` in `.ralph/tasks.json` and output the promise.

## Done
All implementation + tests committed in `6eb5269`, bookkeeping + one spec fix in `368802b`:

- **`app/src/client/ui/touch/use-fire-hold.ts` (NEW)** — `useFireHold(onFire?)` hook: `press()` fires the shared `fireWeapon` IMMEDIATELY (a tap is never slower than the old one-shot), then runs a `requestAnimationFrame` loop calling `onFire` once per frame; `release()`/`stop()` cancel it; `setHeld(on)` is the start/stop for the e2e driver; an `useEffect(() => stop)` kills the loop on unmount. NO client-side rate limiter (spec rule — the server re-derives the weapon cooldown from the fire intents, TASK-42/43).
- **`app/src/client/ui/touch/TouchControls.tsx`** — FIRE button `onPress={fireHold.press}` / `onRelease={fireHold.release}` / `pressed={fireHold.held}` (the accent is the FUNCTIONAL held state now). Three cleanups stop the loop so the ship never fires with no visible control: unmount (hook), disable (the `enabled` effect), and the disembark regime flip (new `onFootActive` effect — the removed FIRE button's `onRelease` never fires on that flip).
- **`app/src/client/touch-debug.ts`** — `fireHold(on: boolean)` on `TouchDebugState`, wired through an OPTIONAL `fireHold` method on the `TouchCombatBridge` interface. `fire()` stays one-shot (legacy e2e depends on it).
- **`app/src/client/main.tsx`** (~line 1587) — a second `useFireHold(fireWeapon)` instance (`debugFireHold`) whose `setHeld` is wired into `touchCombatRef.current.fireHold`; the canvas LMB handler is UNCHANGED (one-shot per click — the keyboard path is untouched).
- **`app/src/client/ui/touch/TouchControls.test.tsx`** — fake rAF clock (`fakeRaf()` helper, stubbed globals, unstubbed in `afterEach`) + new `describe('FIRE hold-to-fire (TASK-101)')`: press fires immediately + ≥1 call per simulated frame (1 → 4 → 9 calls over 3+5 frames); release kills the loop (no calls on 4 later frames); second press starts a fresh loop; unmount while held stops it; disembark flip stops it; disable stops it. The old "one press = exactly one onFire; accent visual only" test was rewritten to the tap-behavior test. 3 new touchDebug bridge tests (fireHold delegate / no-op unbound / no-op when bridge omits it). 50/50.
- **`app/tests/e2e/touch-combat.spec.ts`** — new leg (7.5): a REAL held press on the FIRE button via CDP `Input.dispatchTouchEvent` touchStart (no touchEnd — the only way to HOLD in headless), asserting `aria-pressed=true` while held + screenshot `.ralph/screenshots/TASK-101-1.png`, then touchEnd → accent clears. New leg (7.6): `__TOUCH__.fireHold('true')` for 2.0 s → B's server-reported damage (shields+hull in ABSOLUTE points via `SHIP_CLASSES.scout`) asserted within ±1 shot (±8 dmg) of `2 s × fireRate 3/s × 8 dmg = 48.0` (both `LASER` and `SHIP_CLASSES` imported from `@shared`, not hardcoded), then `fireHold('false')` → no further damage at +0.5 s / +1.5 s. The `touch()` driver gained the `fireHold` action.
- `.ralph/screenshots/TASK-101-1.png` committed (FIRE disc with the cyan accent border during the held press — looked at, correct).
- `.ralph/logs/LOG.md` entry written at top + count bumped 118 → 119.

## Working tree
- All TASK-101 code/tests/screenshot/log are committed (`6eb5269`, `368802b`); this wip commit REVERTS `.ralph/tasks.json` TASK-101 back to `passes: false` (handoff rule: don't close at handoff) and adds this file.
- Pre-existing dirty files NOT touched by this task (leave as-is): `.gitignore`, `.ralph/prd/PRD.md`, `ralph.config.json`, a batch of rewritten screenshots, untracked `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `.ralph/tasks/TASK-{89,101,102}.json`.
- Builds: `npx tsc --noEmit` GREEN; `npm test` GREEN (197 files / 1890 passed / 1 skipped); eslint + prettier clean on all 6 touched files.

## Next steps
In order (each short — total < 15 min):
1. Re-verify the gates: `cd app && npm run typecheck`, then `npm test` (~2.5 min), then `npx playwright test tests/e2e/touch-combat.spec.ts tests/e2e/touch-loop.spec.ts --config playwright.e2e.config.ts` (~2.6 min, expected 2/2).
2. Set `passes: true` for TASK-101 in `.ralph/tasks.json` (the entry is ~line 891).
3. Commit the bookkeeping (Conventional Commit, e.g. `docs(TASK-101): close out`) and output `<promise>TASK-101:DONE</promise>`.

## Dead ends
- `page.evaluate` closures CANNOT reference outer imports: `totalHp` originally read `SHIP_CLASSES.scout` inside the evaluate and blew up with `ReferenceError: _ships is not defined` — pass the constants as evaluate args (the committed fix).
- `locator.tap()` auto-releases, so it can't demonstrate a functional hold in headless — CDP `Input.dispatchTouchEvent` touchStart/touchEnd is the working pattern (used in leg 7.5).
- `touch-loop.spec.ts` failures (landing / re-enter prompt legs) are the DOCUMENTED PRE-EXISTING flake family (see TASK-99/100 LOG entries; proven on clean HEAD). It passed in the final 2/2 run — do NOT chase it for this task.
- An intermediate full `npm test` run had 2 timing reds (no overlap between runs, fully green on re-run) — the documented wall-clock/load-flake family, not this diff.
- Naming `const [held, setHeld] = useState` inside `useFireHold` collided with the returned `setHeld` (TS2451) — renamed the state setter.

## How to verify
- `cd app && npx vitest run src/client/ui/touch/TouchControls.test.tsx` → 50/50 (incl. the `FIRE hold-to-fire (TASK-101)` block and the new bridge tests).
- `cd app && npx tsc --noEmit` → clean.
- `cd app && npx playwright test tests/e2e/touch-combat.spec.ts tests/e2e/touch-loop.spec.ts --config playwright.e2e.config.ts` → 2 passed (touch-combat proves the 2 s sustained rate ≈ shared LASER stats ±1 shot + stop on release; touch-loop is the SC-1 regression gate).
- Look at `.ralph/screenshots/TASK-101-1.png` — the FIRE button shows the cyan accent border (the functional held state) while the CDP touch is down.
