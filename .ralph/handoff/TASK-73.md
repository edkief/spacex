# Handoff: TASK-73 — Flight controls: client ship input loop + prediction

## Status

Implementation (steps 1–3) is committed and flight/landing e2e are green. The ONLY open item is the `enter-ship.spec.ts` flake at the walk-back/re-enter steps — **root cause is now CONFIRMED** (instrumented evidence in this tree), the test-side fix is WRITTEN but not yet verified, and one optional 10-line client fix is identified as the true root-cause fix. Close-out (verify, delete debug spec, set flags, commit) remains.

## Done

- **Root cause CONFIRMED** with new instrumentation (this tree):
  - New dev hook `app/src/client/interact-debug.ts` (`window.__INTERACT__`, mirrors `char-debug.ts`; wired in `app/src/client/main.tsx` in the on-foot rAF loop after `resolvedTargetRef` update + cleared in the snapshot reset block). Exposes the per-frame raycast the E key dispatches: text/targetId/distance/feet. KEEP IT — it is dev-gated and the e2e use it.
  - `app/tests/e2e/debug-entership.spec.ts` (TEMP, delete at close-out) now also: timestamps every WS frame (`t: Date.now()` in the tap) and captures every 'e' keydown (`installEPressCapture` addInitScript → `window.__ePresses`: activeElement tag, e.repeat, DOM prompt text, `__INTERACT__`, `__CHAR__`). Dumps to `/tmp/entership-dump-${DUMP_N}.json`.
  - 10+10 runs characterized, two failure modes, ONE root cause:
    - **Mode A** (walk-back `toHaveText` fails, prompt = `[E] Open cargo`): the `charBack(page, start, 0.6)` stop + release coast parks the character **3.00–3.25 m** from the ship (server positions in dumps, ship at (10160,160)): past the 3 m sub-prompt boundary (`INTERACT_RANGE_M`, `app/src/client/input/interaction.ts` ship entry) → prompt + dispatch go to `open-cargo`.
    - **Mode B** (re-enter `toBeVisible` fails, prompt text was `[E] Enter ship`): run 5 dump is decisive — at the E keydown, DOM prompt = `[E] Enter ship` but `__INTERACT__` = null (raycast resolved NOTHING that frame) and `resolvedTargetRef` is null → **E dispatches nothing** (`main.tsx` E handler: `if (!target) return`). The character's SERVER state was in-range/in-cone (2.70 m, 14.8°); the RAYCAST uses the PREDICTED state (`st.pos/st.quat`), which near the 30° cone / 3 m boundary **flickers resolved↔null frame-to-frame** (release coast + prediction lead). The DOM prompt (React state, commits after rAF) lags the per-frame ref, so a visible prompt can pair with a null dispatch target. This is a real UX race, not just a test artifact.
- **Test-side fix WRITTEN in `app/tests/e2e/enter-ship.spec.ts`** (not yet run): new `charSettled(page)` helper (waits until `__CHAR__` moves < 6 cm/100 ms for 600 ms) + a "prompt as sensor" loop after walk-back: settle → if prompt ≠ `[E] Enter ship`: `Open cargo` → 250 ms W burst (in-cone, W always approaches the ship); hidden → 150 ms turn nudge alternating d/a (ship bearing can be either side); settle again; up to 5 iterations; then `toHaveText('[E] Enter ship', {timeout:15s})` + a 400 ms stability re-check before the screenshot. This fixes Mode A completely; Mode B can still slip a flicker-frame E press, so:
- **Recommended client fix (NOT yet written) — the real root cause of Mode B**: in `app/src/client/main.tsx` on-foot loop, the raycast result must NOT flip to null in a single frame near a boundary. Debounce: keep `resolvedTargetRef` + the prompt state alive for N consecutive null frames (e.g. 3) before clearing/hiding (counter ref, reset on a hit). Invariant: **the prompt only ever shows a target E can dispatch that frame**. ~10 lines in the loop (lines ~1124-1145) + the snapshot reset block; update `promptStateRef` clearing accordingly. This is in scope (TASK-33/35 interaction correctness, test-adjacent but client code — flag it in the commit message; the task note forbids SERVER sim changes only).
- Prior sessions (committed): steps 1–3 impl `b6c8a2e` (`shipInputToPayload`, `flight-loop.ts`, main.tsx ship rAF loop + Q/E gating, unit tests), flight e2e green `feba4aa` + screenshot, landing.spec regions fix `1dc7db0`.

## Working tree

- **Uncommitted (this tree)**: `app/src/client/interact-debug.ts` (NEW — keep), `app/src/client/main.tsx` (hook wiring — keep), `app/tests/e2e/enter-ship.spec.ts` (settle + sensor fix — keep, unverified), `app/tests/e2e/debug-entership.spec.ts` (NEW — DELETE at close-out), `.ralph/split/TASK-73/proposal.json` (harness split proposal — delete or leave; it says "retry, not splittable"), this handoff, `.ralph/decisions.jsonl` (harness — leave to harness record commit).
- **Uncommitted but DO NOT COMMIT**: the M `.ralph/screenshots/*.png` (task note: pre-existing dirty mods).
- **Build state**: `npx tsc --noEmit` had TWO errors when last run (before the last edit): `debug-entership.spec.ts(337,67)` — the dump's local `const msgs: { dir: string; m: Envelope }[] = w.__msgs ?? [];` annotation still lacks `t?: number` (the `window.__msgs` type was updated, the local one wasn't) — fix by adding `t?: number` to that local annotation; and `enter-ship.spec.ts(206,57)` (settle type, fixed by the `Settle` edit after that run — re-run tsc to confirm). So: **fix the debug-spec local annotation, re-run tsc, expect green** (debug spec will be deleted anyway — if you delete it first, only re-verify tsc on the remaining tree).
- No background processes were left running (repro loop finished).

## Next steps

1. `cd app && npx tsc --noEmit` (after fixing the debug-spec `msgs` annotation) — green.
2. Implement the Mode-B client debounce in `app/src/client/main.tsx` (see Done §3). Optionally add a unit test if the logic is extracted; it is a small loop-local counter, so a manual/e2e check is acceptable.
3. Verify the fix: run the debug spec 8–10× — `DUMP_N=v$i npx playwright test -c playwright.e2e.config.ts debug-entership` (each run ~30 s; loop: `for i in $(seq 1 10); do DUMP_N=v$i npx playwright test -c playwright.e2e.config.ts debug-entership >/tmp/v-out-$i.log 2>&1 && echo "run $i PASS" || echo "run $i FAIL"; done`). Expect 10/10 (was 2/10 pre-fix on the debug spec's own sequence).
4. Run the REAL `tests/e2e/enter-ship.spec.ts` 5× with the same loop pattern (it is the spec the task requires green; it has its own screenshots TASK-35-1..4).
5. Close-out, in order: delete `app/tests/e2e/debug-entership.spec.ts`; `cd app && npx tsc --noEmit`; full `npm run test`; e2e set `npx playwright test -c playwright.e2e.config.ts flight landing enter-ship disembark walk inventory`; `eslint --fix` + `prettier --write` on touched files (`main.tsx`, `interact-debug.ts`, `enter-ship.spec.ts`); set `pass: true` on steps 1–4 in `.ralph/tasks/TASK-73.json` AND `"passes": true` for TASK-73 in `.ralph/tasks.json` — **edit JSON with `ensure_ascii=False` semantics (python `json.dump(..., ensure_ascii=False, indent=...)` or plain hand edits, do not let emoji/unicode escape); LOG.md entry at top (date, summary, screenshot `.ralph/screenshots/TASK-73-1.png`); STRUCTURE.md already has the flight-loop line (committed); delete `.ralph/handoff/TASK-73.md`; one Conventional Commit (`fix(client): ...` or `test(e2e): ...`, mention TASK-73, mention the debounce invariant); do NOT commit the dirty screenshots.
6. Output `<promise>TASK-73:DONE</promise>` and stop.

## Dead ends

- Walking back to a fixed 0.6 m distance from the disembark point (original test): the release coast + 2.5 m ship offset lands the char up to ~3.2 m from the ship — flaky by geometry (Mode A). Fixed by settle + prompt-sensor loop (written).
- Assuming Mode B was "E not sent because docked indicator was up" or "server dropped the frame": wrong — dumps show no error frames, `dockedIndicatorVisible: false`, and in Mode B the client never sent `enter_ship` at all because `resolvedTargetRef` was null at the keydown (raycast flicker on the predicted state). The prompt DOM lagging the per-frame ref is the mechanism.
- `page.evaluate` cannot serialize function values in the arg — all dump/capture logic lives in-page (constants/plain-object args only).
- Full-suite rerun takes ~2 min; e2e specs ~30 s each (per-file server boot). Budget accordingly: verification (tsc + unit + 6 e2e specs + 5× enter-ship) ≈ 20–25 min.

## How to verify

- Debug loop green 10/10 + real `enter-ship.spec.ts` green 5/5 (steps 3–4 above).
- Then the standard close-out gates: `npx tsc --noEmit` green; `npm run test` green (was 1323 passed / 1 skipped); e2e set `flight landing enter-ship disembark walk inventory` green; eslint/prettier clean; flags set; LOG entry; handoff deleted; conventional commit.
- Dumps from prior runs are in `/tmp/entership-dump-*.json` (runs 1–11 + rework 1–8) if you want the raw evidence.
