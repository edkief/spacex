# TASK-93 handoff — Touch on-foot: move stick + run/jump/drop/interact

## Status
Step 1 (implementation) is complete and unit-verified; step 2 (e2e) is at legs 1–3 green, leg 4 (re-enter) was rewritten to a bearing-steer loop but NOT yet re-run. Remaining work: run the e2e until green, run the keyboard-regression specs, bookkeeping + commit.

## Done
- `app/src/client/touch-debug.ts` — on-foot half of `window.__TOUCH__`: `move({thrust,yaw})` / `run(on)` / `jump(on)` delegate to the bound source; `interactPress()` / `interactRelease()` / `drop()` delegate via a new `TouchOnFootBridge` + `bindTouchOnFoot()` (mirrors the TASK-92 combat bridge). No-op-safe before binding.
- `app/src/client/ui/touch/TouchControls.tsx` — on-foot layout renders when `regime==='surface' && onFoot` (new props: `onFoot`, `onInteractPress`, `onInteractRelease`, `onDrop`): `#touch-stick-move` (thrust: y, yaw: x → same virtual keys as the on-foot loop), `#touch-btn-run` (run channel → 'Shift'), `#touch-btn-jump` (jump channel → ' '), `#touch-btn-drop` (one-shot → onDrop), `#touch-btn-interact` (controlled `pressed`, press/release → onInteractPress/onInteractRelease). Hygiene: entering the surface clears flight channels; leaving the surface clears on-foot channels; a held INTERACT fires onInteractRelease when the layout unmounts. Flight layout untouched.
- `app/src/client/main.tsx` — extracted the shared discrete paths (TASK-92 ref pattern): `interactPressRef` (E-down: docked→exit_ship guard stays in the keydown wrapper; else dispatch via interactRegistry → mine-start/enter-ship/open-cargo), `interactReleaseRef` (E-up/blur: registry release → mine-stop), `dropHeldRef` (Q: on-foot only, first owned resource, drop 1). Keyboard E/Q keydown/keyup are now thin wrappers (behaviour-identical). `bindTouchOnFoot` bound over the refs. `<TouchControls>` now gets `onFoot={hudMode === 'onfoot'}` + the three callbacks. On-foot loop / character physics / InteractableRegistry / server: UNTOUCHED.
- `app/src/client/ui/touch/TouchControls.test.tsx` — +11 on-foot layout tests + 3 touchDebug on-foot driver tests. All 52 tests in the file pass.
- `app/tests/e2e/touch-onfoot.spec.ts` (new) — touch-emulated browser; server-side prep mirrors walk/interact/enter-ship specs (claim → pad-target → raw WS dock → browser takes token, keyboard E to disembark). Drives via `window.__TOUCH__` page.evaluate. Legs: (1) layout present + flight sticks absent; (2a) move thrust 2.5 s → server `__CHAR__` position ≥ 4 m, y drift < 1; (2b) 400 ms yaw burst → dot(facing,+Z) < 0.8; (3) deposit 1.5 m in front of current facing, interrupted 600 ms hold → weight bar 0/40u + deposit qty 1 (mine-stop cancels), full 1.8 s hold → 1/40u + prompt hides; (4) steer to the ship (docked at `target.pad`), prompt-as-sensor until '[E] Enter ship', `interactPress()` re-enters → docked stubs return + on-foot layout gone; screenshot `.ralph/screenshots/TASK-93-1.png`.
- Verified this session: `npx tsc --noEmit` green; `vitest run src/client/ui/touch/TouchControls.test.tsx src/client/input/touch.test.ts` 52/52; full `npm run test` 1841 passed / 1 failed — the failure is `src/client/world/streaming-benchmark.test.ts` (sliceP99 timing), which passes 3/3 in isolation — pre-existing flake, not from this task; eslint --fix + prettier --write applied to all touched files; e2e legs 1–3 green in the run that failed at leg 4.

## Working tree
Uncommitted, ALL from this task (stage exactly these):
- `app/src/client/main.tsx`
- `app/src/client/touch-debug.ts`
- `app/src/client/ui/touch/TouchControls.tsx`
- `app/src/client/ui/touch/TouchControls.test.tsx`
- `app/tests/e2e/touch-onfoot.spec.ts` (new)
- `.ralph/handoff/TASK-93.md` (this file)

Pre-existing dirty files NOT part of this task — do not commit: `.gitignore`, `.ralph/prd/PRD.md`, `ralph.config.json`, all modified `.ralph/screenshots/*.png`, `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `.ralph/tasks/TASK-89..95.json`, `app/.ralph/`.

Builds: tsc green, units green (modulo the known flake). No background processes left running (the e2e fixture boots/tears down its own server).

## Next steps
1. `cd app && npx playwright test --config playwright.e2e.config.ts touch-onfoot` (test timeout 180 s). Leg 4's new steering loop is UNVERIFIED — if it fails, read `test-results/touch-onfoot-*/error-context.md` (shows the prompt text at failure) and the `test-failed-1.png` screenshot, then tune the loop constants (alignment threshold 0.4 rad, 150 ms yaw nudges, W-burst sizing `(dist-3.2)/3`).
2. Once green, confirm `.ralph/screenshots/TASK-93-1.png` was written.
3. Keyboard regression gate (the refactored E/Q paths): `npx playwright test --config playwright.e2e.config.ts walk interact mining enter-ship` plus `touch-flight touch-combat` (shared source/regime paths). All must stay green.
4. Full `npm run test` (if the streaming-benchmark flake resurfaces, re-run that file alone to confirm).
5. Bookkeeping: `.ralph/tasks/TASK-93.json` both step `"pass"` flags → true; `.ralph/tasks.json` TASK-93 `"passes": true`; LOG.md entry at the top (date, summary, screenshot path, bump Tasks Completed); delete this handoff; commit only the files listed under Working tree as `feat(TASK-93): touch on-foot — move stick + run/jump/drop/interact (shared paths)`.

## Dead ends
- **Blind backward walk for re-enter** (thrust −1 for 3 s): does NOT work — the mining leg leaves the facing yawed ~69° off the walked line, so backward drift parks the character metres off the return line; the prompt never appears (observed: failure at `toHaveText('[E] Enter ship')`, page shows the on-foot layout + weight bar 1/40u, no prompt).
- **Alternating ±yaw nudges without bearing info** (the enter-ship.spec pattern assumes the ship is on a known side): can spin the wrong way from the final facing; too slow to converge in a bounded loop.
- **Reading `__CHAR__.rot` before the yaw burst**: the wire omits identity quats (`entityToState` in `shard.ts` only sends `rot` when the quat differs from identity), so the pre-burst facing is +Z by construction — assert `dot(facing, +Z)` after the burst instead.

## How to verify
- `cd app && npx tsc --noEmit` → green
- `cd app && npx vitest run src/client/ui/touch/TouchControls.test.tsx src/client/input/touch.test.ts` → 52/52
- `cd app && npx playwright test --config playwright.e2e.config.ts touch-onfoot` → the full spec green (legs 1–3 verified this session; leg 4 pending)
- `cd app && npx playwright test --config playwright.e2e.config.ts walk interact mining enter-ship` → keyboard paths behaviour-identical
