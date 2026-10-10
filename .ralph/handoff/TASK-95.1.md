# TASK-95.1 handoff — Touch loop e2e: warp flake + land leg + legs 6–10

## Status

The land-leg VTOL non-engagement is ROOT-CAUSED and FIXED (client-local touch wiring: `TouchControls.tsx` cleared the held VTOL channel at the atmosphere→surface touchdown flip), the warp-leg flake is fixed (force clicks), the spec is retuned to this seed (75 m start / 15 m switch) — all committed, tsc + touch unit tests green. The only thing left is running the spec (it did not fit the 45-min iteration budget) and getting legs 6–10 green.

## Done

- **`app/tests/e2e/touch-loop.spec.ts`** (committed):
  - Step 1 (warp flake): `padNode.click({ force: true })` + `warpButton.click({ force: true })` with the z-index/DOM-order comment (ESC menu co-open under the chart, later in DOM at z 111). Survived run 7.
  - `__TLIN__` tap: the WebSocket monkey-patch in `tapShipUpdates` now also intercepts `send` and records outbound `type === 'input'` frames (seq/thrust/yaw/pitch/turn/action) into `window.__TLIN__`. KEPT per the spec (permanent diagnostic).
  - `lastInFrames(page, n)` helper; vtol-switch probe and the 25 s timeout both log the last sent wire frames.
  - Scheme-swap capture: a `page.on('console')` listener collects `controls remap` log lines (`schemeSwaps`), printed on land success/failure.
  - Land leg retuned: `LAND_START_DIST_M` 85 → **75** (this seed's planet is denser than the unit test's — run 7 measured an 85 m start dead-sticking ~61 m of horizontal travel → grounding at 23 m, outside the 20 m disc; 75 m → grounds ~13–14 m, INSIDE); VTOL switch `dist <= 25` → **`dist <= 15`** (over the disc — the server assist damps drift in place, so switching outside the disc freezes the ship short; mirrors the unit test's effective switch); after dock: `touch(page, 'clear')` releases the lift (also stops ` ` → JUMP leaking on egress).
- **`app/src/client/ui/touch/TouchControls.tsx`** (committed — the ONE product change): the regime-flip hygiene effect (`prevRegimeRef`) now clears on entering surface ONLY when `onFoot` (disembarded); the in-ship touchdown KEEPS the held VTOL so the 1.35·g lift settles the landing (keyboard parity — a held Space key survives the flip).
- **`app/src/client/ui/touch/TouchControls.test.tsx`** (committed): 2 regression tests (held VTOL survives the in-ship surface flip; disembarking clears it). All 80 touch tests pass.
- **`.ralph/split/TASK-95/handoff.md`** (committed): full diagnosis record + next steps.
- NO server / wire / prediction / golden-fixture changes. NO main.tsx changes (its regime wiring was proven correct — see the diagnosis below). NO facePad/steering.

## Working tree

- Committed this iteration: the 5 files above (see `git log -1` — commit message `wip(TASK-95.1): …`).
- Everything else dirty in `git status` is PRE-EXISTING (screenshots, `.ralph/prd/PRD.md`, `.ralph/decisions.jsonl`, `.gitignore`, `ralph.config.json`, `app/.ralph/`, `app/.trace-tmp/`, untracked TASK-89..92 specs) — NOT this task's, do not commit.
- `app/test-results/` — scratch from run 7 (untracked), can be ignored/removed.
- Build state: `npx tsc --noEmit` GREEN (verified); touch unit tests 80/80 GREEN (verified); the full spec run NOT done this iteration (see Next steps).

## Next steps

1. **Run the spec** (~6 min, foreground): `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line` (the e2eServer fixture boots its own dev server — NEVER alongside `npm run dev`). Expected: warp + space legs green; land leg DOCKED with `vtol-held-at-dock=true`; then legs 6–10 (exit → mine 1/40u → re-enter → sell 505 cr) executing for the FIRST time — expect first-touch issues there (walkUntilPrompt is verbatim from the green touch-onfoot.spec.ts; egress uses the committed `interactPress` path).
2. **Iterate legs 6–10 SPEC-SIDE only** if red (timeouts, prompt strings, walk bursts, settles). If a leg reveals a real product bug: stop, record it here, do NOT silently special-case around it.
3. Green bar: the WHOLE spec in ONE run + `assertClean()` + screenshot `.ralph/screenshots/TASK-95-1.png` rewritten at the sold/dock state + CAPTURE the `[TASK-95] loop wall=…s` console line (TASK-95.2 records it in the LOG; put it in the commit message).
4. Close: `cd app && npx tsc --noEmit` green; one wip commit of only the task's files: `wip(TASK-95): touch-loop e2e fully green (warp force-click; land leg = TouchControls in-ship VTOL fix + 75 m/15 m retune; legs 6-10; loop wall=…s)`; then set this task's steps + TASK-95.1 `passes` in `.ralph/tasks.json` and LOG. TASK-95.2 (docs + full gate + close-out) comes next.

## Dead ends

- **Stale client scheme (the prime suspect from the parent handoff): REFUTED.** Run 7's wire tap shows the client sent `action:"vtol"` frames (seq 201–203) and the scheme swaps logged `space → atmosphere → surface` correctly. Do not touch main.tsx.
- **facePad steering after the atmosphere teleport: RESOLVED BY DESIGN** (the land leg does no steering); its true cause was the flip-clear in TouchControls.tsx (now fixed). Do NOT resurrect facePad.
- **100 m start (the unit test's): does not transfer** — this seed's planet is denser (85 m start dead-sticks ~61 m → grounds ~23 m out; 100 m would ground ~39 m out). 75 m start is the tuned value for this seed.
- **VTOL switch at 25 m (unit test's trigger distance): unsafe here** — the server assist (×0.5/tick on horizontal drift, up > 0) damps the drift IN PLACE, so switching outside the 20 m disc freezes the ship just short. Switch at 15 m (over the disc).
- From the parent handoff, still true: 60 m straight drop (instant re-dock hides the atmosphere regime); 300 m/150 m with thrust (the atmosphere has no thruster).

## How to verify

- `cd app && npx tsc --noEmit` — green at handoff.
- `cd app && npx vitest run src/client/ui/touch/ src/client/input/touch.test.ts` — 80/80 green at handoff (includes the 2 new TouchControls touchdown tests).
- `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line` — NOT yet run at handoff (time); this is the single remaining gate for this task.
