# TASK-100 handoff — analog on-foot move/turn

## Status
Implementation is COMPLETE and verified: the shared `CharacterInput` is analog (`move`/`turn` floats), `integrateCharacter` scales speed/turn rate linearly, the wire mapping passes magnitudes through clamped to [−1,1], and the client on-foot loop merges the touch MOVE stick via `mergeAxis`. Full unit suite green (1881 passed / 1 skipped), `tsc` clean, and the new e2e test passes with ratio 0.500 speed / 0.526 turn. Only close-out remains (lint/format pass, one flight-touch spec run, LOG.md + `passes: true`, final conventional commit).

## Done
All work is UNCOMMITTED in the working tree (files below).

- `app/src/shared/physics/character.ts` — `CharacterInput` is now `{ move: number; turn: number; run: boolean; jump: boolean }` (move forward-positive, turn screen-LEFT-positive per TASK-80). `ZERO_CHARACTER_INPUT` updated. `characterSubstep`: `turn > 0` → rotate `+CHAR_TURN_RATE*turn*h`; `turn < 0` → `−CHAR_TURN_RATE*|turn|*h`; `move ≠ 0` → horizontal vel = facing × `sign(move)` at `(run ? CHAR_RUN_SPEED : CHAR_WALK_SPEED) * |move|`; `move = 0` keeps the friction path unchanged. CHAR_* constants, jump physics, friction law untouched. Doc comments rewritten.
- `app/src/shared/protocol/inputs.ts` — `inputToCharacterInput` now returns `{ move: clampAxis(thrust), turn: clampAxis(-input.yaw), run, jump }`. `clampAxis` clamps to [−1,1] and normalizes −0. Sign flip: wire yaw is screen-RIGHT positive (D → +1), physics turn is screen-LEFT positive, so D maps to turn = −1. Old 0.5 thresholds removed; doc comment rewritten (TASK-55 sensitivity: 0.5x preset now turns at HALF rate, 1x/2x clamp to ±1). Server shard needed no change (it only calls `inputToCharacterInput` + `ZERO_CHARACTER_INPUT` — verified by grep, `app/src/server/shard/shard.ts:1955`).
- `app/src/client/main.tsx` (on-foot loop, ~line 1708) — axis readout from the REAL keyboard set only (`pressedRef.current`, because the MOVE stick's own virtual keys 'w'/'s'/'a'/'d' would read ±1 and flatten the stick back to binary), merged per axis with `touchRef.current.snapshot()` thrust/yaw via `mergeAxis` (TASK-99, import added at line 171). `yaw = mergeAxis(kbYaw, ch.yaw ?? 0) * settingsState().sensitivity` (sensitivity multiplication kept after the merge). run/jump read from the merged pressed set as before. No active touch channel ⇒ payload byte-for-byte the legacy one.
- `app/src/client/char-debug.ts` + main.tsx — `__CHAR__.vel` added (server-authoritative velocity; the e2e speed asserts read it). Populated in the self-character entity_update handler.
- Tests updated to the new shape: `app/src/shared/physics/character.test.ts` (all fixtures → `move:`/`turn:`; legacy golden expectations UNCHANGED — that is the keyboard-parity proof), `app/src/client/world/character-ground.test.ts` (WALK literal), `app/src/shared/protocol/inputs.test.ts` (inputToCharacterInput suite rewritten: pass-through 0.5, sign flip, clamp ±1/±100/yaw=2, canonical +0 zero). New unit block "integrateCharacter: analog magnitudes (TASK-100)": move=±0.5 → half speed (±2%), move=0.5+run → half run speed, turn=±0.5 → exactly half the facing delta of ±1, move=0 friction band, keyboard-parity golden re-assertion.
- E2E `app/tests/e2e/touch-onfoot.spec.ts` — added second test "touch on-foot ANALOG" (same dock → touch-browser → disembark setup): server speed via `__CHAR__.vel` at {thrust:1} baseline, {thrust:0.5} in [0.4, 0.6]× full and > 0, then two fixed 600 ms yaw bursts ({yaw:1} vs {yaw:0.5}) compared via server-quat facing angle in the same band. Screenshot saved to `.ralph/screenshots/TASK-100-1.png`. Also fixed `charForward()` there: missing `__CHAR__.rot` now reads as the identity quat +Z (the wire OMITS identity quats — `entityToState`, shard.ts:4249).
- Verified this session: full `npm test` → 1881 passed / 1 skipped; `npx tsc --noEmit` clean; `npx playwright test --config=playwright.e2e.config.ts tests/e2e/touch-onfoot.spec.ts` → 2/2 passed with `[TASK-100] full=3.00 u/s partial=1.50 u/s ratio=0.500 turnFull=2.85 rad turnPartial=1.50 rad turnRatio=0.526`.

## Working tree
Uncommitted (this task's files): the 8 files listed in Done. Plus untracked `.ralph/screenshots/TASK-100-1.png` and this handoff. The tree also carries PRE-EXISTING modifications from earlier iterations that are NOT this task's and must not be committed: `.gitignore`, `.ralph/prd/PRD.md`, `ralph.config.json`, ~120 `.ralph/screenshots/TASK-*.png`, untracked `.ralph/tasks/TASK-{89..102}.json`, `app/.ralph/`, `app/.trace-tmp/`, `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`.
Not done: no `passes: true` in `.ralph/tasks.json` (TASK-100 is at line ~889), no LOG.md entry, no lint/format pass run, no final commit. Builds and typechecks clean; unit + touched e2e green.

## Next steps
1. Optional AC check: `cd app && npx playwright test --config=playwright.e2e.config.ts tests/e2e/touch-flight.spec.ts` (flight touch spec — my change didn't touch the ship loop, but the AC says "still green").
2. `cd app && npx eslint --fix src/shared/physics/character.ts src/shared/physics/character.test.ts src/shared/protocol/inputs.ts src/shared/protocol/inputs.test.ts src/client/main.tsx src/client/char-debug.ts src/client/world/character-ground.test.ts tests/e2e/touch-onfoot.spec.ts && npx prettier --write <same 8 files>` (run prettier first if it reorders; both are quick).
3. Re-run `npm test` once (≈2.5 min) to confirm green after formatting.
4. Close out: set `"passes": true` for TASK-100 in `.ralph/tasks.json`; add a LOG.md entry at the top (date, summary, screenshot `.ralph/screenshots/TASK-100-1.png`); NO STRUCTURE.md change (no dirs added); delete this handoff file.
5. Commit ONLY the task's files (8 files + tasks.json + LOG.md + screenshot + handoff deletion) as e.g. `feat(TASK-100): analog on-foot move/turn through shared CharacterInput + physics`, then output `<promise>TASK-100:DONE</promise>`.

## Dead ends
- `touch-loop.spec.ts` fails on this machine (run 1: "land leg: still 88 m from the pad after 3 glides"; run 2: interact-prompt not hidden at re-entry). CONFIRMED PRE-EXISTING: `git stash` my changes → same failure on clean HEAD. Environmental instability (software GL), not caused by this change — do not chase it.
- My first e2e run: `fullSpeed = -1` because `avgCharSpeed`'s `page.evaluate((window) => ...)` shadowed the global `window` with the `ms` number. Fixed the parameter name.
- Second e2e failure: `charForward` got null at spawn — the wire omits identity quats. Fixed the helper to treat missing rot as +Z.
- `character.test.ts` friction assertion: a ±2% band was too tight (the last friction tick overshoots to 0: measured 0.2 s vs analytic 0.1875 s). Used a ±1-tick band, matching the legacy full-key test's style.
- `npx playwright test tests/e2e/...` with the default config says "No tests found" — e2e specs are excluded from `playwright.config.ts`; always use `--config=playwright.e2e.config.ts`.
- Full-suite flake: `tests/abuse/abuse.spec.ts` "4. mine spam" timed out once under full parallel load; passes in isolation and on a standalone full-file run. Load-sensitive, pre-existing pattern.

## How to verify
- `cd app && npm test` → 1881 passed / 1 skipped (all green).
- `cd app && npx tsc --noEmit` → clean.
- `cd app && npx playwright test --config=playwright.e2e.config.ts tests/e2e/touch-onfoot.spec.ts` → 2/2; console line `[TASK-100] full=3.00 u/s partial=1.50 u/s ratio=0.500 turnFull=… turnPartial=… turnRatio≈0.5`.
- Keyboard parity: the pre-task golden expectations (3 m walk in 1 s, exactly `CHAR_TURN_RATE` of yaw per second at ±1) are unchanged in `character.test.ts` and green — the legacy boolean behavior is exactly the |input| = 1 case of the new analog model.
