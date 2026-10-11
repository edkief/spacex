# TASK-104 handoff — touch disconnect fix (input/fire pacing)

## Status

Implementation is COMPLETE and locally verified (unit green, e2e RED pre-fix + 3× GREEN post-fix,
screenshot saved), but NOTHING is committed yet and the remaining gates (full unit re-run after the
final FirePacer fix, tsc, the 7-spec e2e regression set, eslint/prettier) plus the .ralph bookkeeping
and the commit are still to do. Estimated 20–30 min of mostly gate-running.

## Done

All code changes (uncommitted, see Working tree):

1. `app/src/client/input/flight-loop.ts`
   - `INPUT_SEND_PERIOD_MS` 50 → 66, comment rewritten (66 ms ≈ 15.2 msg/s, under the 20 msg/s
     bucket; cites TASK-104/TASK-65/TASK-14).
   - `InputFrameSender.shouldSend(nowMs): number | null` — PURE period, `key` param and `lastKey`
     field removed. `lastSendMs = Number.NEGATIVE_INFINITY` (first call always sends — load-bearing
     for the docked take-off contract). Header comment updated.
2. `app/src/client/input/flight-loop.test.ts` — cadence describe rewritten to the new contract
   (first frame sends at t=0; key change inside period sends nothing — literal 65/66 ms stamps;
   boundary re-sends same key; key change AT boundary = one send; monotonic-seq and no-repeat tests
   re-based). `loopFrame` helper now calls `shouldSend(nowMs)`. shipInputKey test name updated
   ("stable wire-fingerprint").
3. `app/src/client/ui/touch/use-fire-hold.ts`
   - `export const FIRE_HOLD_MIN_INTERVAL_MS = 333` and `export class FirePacer` (DOM-free,
     clock-injected, `last = -Infinity`, `due()`, `reset()`). Pacer is created LAZILY on first
     press (`pacerRef.current ?? (pacerRef.current = new FirePacer(...))`) so a test's fake clock
     is in effect before the first read.
   - `press()`: immediate first shot is UNCONDITIONAL + `pacer.reset()` (re-arms per press); rAF
     step keeps running every frame, only the intent is gated by `pacer.due()`. Hook signature,
     release/stop semantics unchanged. Header comment rewritten.
4. `app/src/client/ui/touch/use-fire-hold.test.ts` (NEW) — 5 pacer tests (default constant 333,
   first due at t=0, 2 s @60 Hz → 7-8 fires, 2 s @120 Hz same count, inside-interval call does not
   move the clock).
5. `app/src/client/main.tsx` — both call sites now `inputSender.shouldSend(now)` (on-foot loop
   ~line 1743, flight loop ~line 1912); unused `shipInputKey` import removed.
6. `app/src/client/ui/touch/TouchControls.test.tsx` — the 4 old per-frame fire tests (TASK-101)
   asserted the exact pre-fix behaviour this task removes, so they were rewritten to the paced
   contract; `fakeRaf()` now also advances `performance.now` via `vi.spyOn(performance, 'now')`
   (16 ms/frame), `vi.restoreAllMocks()` added to `afterEach`.
7. `app/tests/e2e/touch-flood.spec.ts` (NEW) — legs A (8 s 33 Hz flight-stick jitter), B (5 s
   fire-hold + thrust), C (dock-at-pad + disembark + 5 s on-foot move jitter). NET tap via
   `context.addInitScript` wraps WebSocket BEFORE session code runs: counts outbound input/fire,
   records closes. 500 ms `reconnecting` DOM watcher. Asserts no 4009, zero reconnect hits,
   ≤85 input / ≤17 fire over 5 s windows, server speed > 5 u/s (leg A). Screenshot
   `.ralph/screenshots/TASK-104-1.png` (verified: touch layout mid-jitter, SPD 37.4 m/s).

Verified this session:
- RED pre-fix: `git stash push` of the 3 impl files → spec FAILED on leg B alone
  ("fire intents over 5 s = 96", must be ≤ 17). (Leg A's in-page 33 Hz `setInterval` ran slower
  than nominal under headless load, so no 4009 on that leg — leg-B-alone RED is what the spec
  explicitly requires.)
- Post-fix: 3 consecutive green runs — leg A input 35/36/36 over 5 s, leg B fire 15/15/15,
  leg C input 63/59/59; no closes, zero reconnect hits, all three legs.
- Targeted vitest green: flight-loop.test.ts + use-fire-hold.test.ts + TouchControls.test.tsx
  (72 tests, then 58 after the final FirePacer fix).
- `npx tsc --noEmit` green as of the pre-FirePacer-fix state (needs one re-run — see Next steps).

## Working tree

Uncommitted (all part of this task — stage exactly these):
- `app/src/client/input/flight-loop.ts` (M)
- `app/src/client/input/flight-loop.test.ts` (M)
- `app/src/client/main.tsx` (M)
- `app/src/client/ui/touch/use-fire-hold.ts` (M)
- `app/src/client/ui/touch/use-fire-hold.test.ts` (new)
- `app/src/client/ui/touch/TouchControls.test.tsx` (M)
- `app/tests/e2e/touch-flood.spec.ts` (new)
- `.ralph/screenshots/TASK-104-1.png` (new)
- `.ralph/handoff/TASK-104.md` (this file)

Builds/tests: code state is green in isolation (see Done), but the FULL suite has NOT been re-run
since the last two edits (FirePacer receiver fix + TouchControls test rewrites were verified only
in targeted runs). The 22:36 full-suite run predates those and showed exactly the 5 TouchControls
failures that the rewrites fix — the full re-run is the first gate.

Pre-existing dirty files that must NOT be committed: the many `M .ralph/screenshots/*.png`,
`M .gitignore`, `M .ralph/prd/PRD.md`, `M .ralph/tasks.json` (flipped separately at close-out),
`M ralph.config.json`, untracked `.ralph/tasks/TASK-*.json`, `app/.ralph/`, `app/.trace-tmp/`,
`.agents/skills/browser-check/`, `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`,
`.ralph/logs/t83/`.

## Next steps

In order (all from `app` unless noted):
1. `npx tsc --noEmit` — expect green.
2. `npm run test` (~2.5 min) — full unit suite must be green (the 5 old TouchControls failures are
   fixed by the committed test rewrites; everything else was green at 22:36: 1902 passed / 1 skipped).
3. E2E regression set:
   `npx playwright test --config playwright.e2e.config.ts touch-flight touch-onfoot touch-loop touch-combat touch-padded touch-menu walk`
   (~8–12 min). touch-loop is the ~160 s SC-6 loop: if it flakes ONCE, re-run it in ISOLATION
   before judging (repo flake protocol).
4. `npx eslint --fix` + `npx prettier --write` on the 7 touched files.
5. `git diff --stat` sanity check (only the task files).
6. Close-out bookkeeping (repo root): set `"passes": true` for TASK-104 in `.ralph/tasks.json`
   (find the TASK-104 entry — the file has uncommitted pre-existing mods, edit ONLY the flag);
   newest-at-top entry in `.ralph/logs/LOG.md` (date, brief summary, screenshot
   `.ralph/screenshots/TASK-104-1.png`, bump 'Tasks Completed' by 1); no STRUCTURE.md change needed
   (no new dirs — new files live in existing dirs).
7. Commit EXACTLY the 9 task files listed in Working tree (NOT `tasks.json` if it carries unrelated
   pre-existing mods — check `git diff .ralph/tasks.json` first; if the diff is only the passes
   flag, include it). Conventional commit per the spec:
   `fix(TASK-104): cap touch input/fire sends to the inbound bucket (no more 4009 kicks on touch)`
   with body recording: pure 66 ms input period (key changes no longer bypass the cadence); 333 ms
   fire-intent pace; worst-case legit traffic ≈18.2 msg/s < 20 (TASK-65); server/protocol/shared/
   cheat-resistance UNCHANGED; keyboard payloads byte-identical (only the send period moved
   50 → 66 ms).
8. Delete this handoff file; output `<promise>TASK-104:DONE</promise>`.

## Dead ends

- `FirePacer` default clock `now = performance.now` (bare method reference) → "Illegal invocation"
  at runtime in the browser when called as `this.now()` (receiver lost). Fixed with the closing
  closure `() => performance.now()` and an explicit `this.now = now` assignment (a second edit was
  needed after the first: the `private readonly` parameter-property was removed without the
  assignment → "this.now is not a function"). Both bugs only surfaced via the e2e `fireHold(true)`
  driver, not unit tests (injected clock).
- First draft of the flight-loop rewrite used symbolic `INPUT_SEND_PERIOD_MS` timestamps in the
  new tests, which passed against the OLD 50 ms implementation (no RED). Fixed with literal
  65/66 ms stamps per the spec.
- `vi.stubGlobal('performance', { now })` in TouchControls.test.tsx would clobber the rest of the
  Performance API (React/happy-dom internals) — replaced with `vi.spyOn(performance, 'now')`.
- Pre-fix leg A did not produce a 4009: the in-page `setInterval(…, 30)` runs well under 33 Hz
  under headless software-GL load (measured input ≈7 msg/s, never draining the 40-token burst).
  Not worth chasing — the spec's leg-B-alone RED is the mandated pre-fix proof and it fired.

## How to verify

- Unit: `cd app && npx vitest run src/client/input/flight-loop.test.ts src/client/ui/touch/use-fire-hold.test.ts src/client/ui/touch/TouchControls.test.tsx` (72 tests).
- Full: `cd app && npm run test` (expect ~1908 tests, all green) + `npx tsc --noEmit`.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts touch-flood`
  (self-booting server fixture, ~45 s, `test.setTimeout(240_000)`; logs leg rates, e.g.
  `leg B: fire intents over 5 s = 15 (≤ 17)`).
- Regression: the 7-spec set in Next steps #3.
- No server files touched: `git diff --name-only` must not include `app/src/server/**`,
  `app/src/shared/**`, or any fixture.
