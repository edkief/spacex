# TASK-95.1 handoff — Touch loop e2e: warp flake + land leg + legs 6–10

## Status

Legs 1–8 VERIFIED GREEN in runs 10/12/13: claim → warp (chart node + WARP) →
space thrust+yaw → **land (the 130 m probe glide DOCKED at 1.0 m on glide 1,
no VTOL needed)** → exit (egress) → mine (1/40u bar). Two root-cause fixes
landed this iteration (committed `4fcdc91`): the warp-leg coordinate-click
flake and the teleport poll (server tap, not rendered ship). Leg 9 (re-enter)
had ONE red — the character parks ~1.8 m from the ship with it to the SIDE,
outside the ±30° raycast cone, so `[E] Enter ship` never arms. `reEnterShip`
helper applied (committed) — **not yet verified in a full run.** Legs 9–10
pending. The whole spec has NOT run fully green in one pass yet.

## Fixes applied this iteration (committed `4fcdc91`)

- **Warp leg — `dispatchEvent('click')` on the node (NOT `{ force: true }`).**
  Run 9 root-caused it: `force: true` makes Playwright dispatch by
  COORDINATES, but the BROWSER still hit-tests that point — the co-open
  #esc-menu (z-index 111, later in DOM) captures the coordinate, the node's
  onClick never fires, the selection never lands and `#warp-button` stays
  disabled. `padNode.dispatchEvent('click')` fires the React onClick directly
  on the node — deterministic, seed-independent, surface-stack untouched.
  (The task spec's "force:true, 2 lines" was the wrong fix — force still
  hit-tests; dispatch is the spec-side bypass that actually works.)
- **`teleport()` polls the SERVER tap `__TL__`, NOT the rendered ship.**
  The dev route hard-sets the SERVER state; the client predictor does NOT snap
  to a large state jump (it keeps integrating its own local state, which can
  be a full planet away — the run-11 screenshot showed the rendered ship
  grounded/SURFACE while the server had already moved it). Polling `__SELF_SHIP__`
  (rendered) was the outlier in a spec whose other assertions are all
  server-tapped. Tolerance widened to a 60 m band (a 5 m ball is transited in
  ~55 ms < one 10 Hz broadcast interval → a tight tolerance flakily misses).
  This ALSO explains the run-8 "climb anomaly": the server vel seed (−90,0,0)
  WAS applied cleanly every run (post-teleport dumps showed valid glides); the
  "space-leg velocity leak" was the RENDERED predictor not snapping, misread
  as a server leak. No product change.
- **`charForward` identity-quat fallback.** The wire OMITS `rot` when it is
  identity (entityToState, shard.ts) and a disembarked character spawns
  identity-facing (handleExitShip), so `__CHAR__.rot` stays undefined until the
  first yaw — the missing quat IS the server's identity state, not a stale tap.
- **`reEnterShip` helper (leg 9).** The `[E] Enter ship` prompt is a RAYCAST:
  ≤ 3 m AND the ±30° forward cone (shared/interaction.ts `nearestInteractable`)
  — distance alone does not arm it. The `walkUntilPrompt` bearing-walk
  converges DISTANCE (walking within 45° always shortens it) but at a 30–45°
  bearing it walks a straight burst with no turn, so it ORBITS the ship and the
  facing never settles inside the cone (the run-13 screenshot: ship to the
  character's side, prompt hidden). `reEnterShip` = (1) CLOSE with the bearing
  walk until ≤ 2 m (the 3 m sub-zone, not the 3–5 m 'Open cargo' zone), then
  (2) FACE: turn IN PLACE toward the signed bearing (the enter-ship.spec.ts
  TURN pattern), re-reading the prompt at rest, until the ship is inside the
  cone → `[E] Enter ship` arms.

## Verified green (runs this iteration)

- Warp: `dispatchEvent` node click → WARP enabled → warp completes → `sys` id.
- Space: thrust speed rising (1.2 → higher), yaw burst dot(forward, right) > 0.2.
- **Land: the 130 m PROBE glide DOCKED at dist 1.0 m in ~7 s (vtolHeld=false —
  the dead-stick lands dead-on this seed's corridor, no VTOL switch needed).**
  Scheme swaps clean: `space → atmosphere` (teleport), `atmosphere → surface`
  (touchdown). In-frames near the teleport are all zeros (no channel leak).
- Exit: `#leave-ship-prompt` → `#docked-indicator` hidden, `#weight-bar` visible.
- Mine: deposit 4 m ahead, walk, full interactPress hold > 1.5 s → `1/40u` bar,
  mining HUD, prompt hidden. (Run 13 screenshot confirmed 1/40u.)

## Next steps (ONE run)

1. **Full spec run** (~5–6 min, foreground):
   `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line`
   (e2eServer fixture boots its own dev server — NEVER alongside `npm run dev`).
   Expect legs 1–8 green again; **leg 9 re-enter should now arm via `reEnterShip`**;
   leg 10 sell: exit → `walkUntilPrompt` to `[E] Dock terminal` (20 m out, the
   mining-case geometry — should work) → interactPress → `#dock-panel` → TAP
   `button[aria-label="sell all iron inv"]` → 500 → 505 cr + `0/40u`. If a leg
   is red, iterate SPEC-SIDE only (timeouts, burst sizes, prompt strings). If a
   leg reveals a real product bug: stop, record it, do not silently special-case.
2. Green bar: WHOLE spec in ONE run + `assertClean()` + screenshot
   `.ralph/screenshots/TASK-95-1.png` rewritten at the sold/dock state + CAPTURE
   the `[TASK-95] loop wall=…s` line (put it in the commit message).
3. Close: `npx tsc --noEmit` green (was green at this handoff); one wip commit of
   ONLY the task's files: `wip(TASK-95): touch-loop e2e fully green (warp
   dispatchEvent; land = dead-stick probe docked 1.0 m; teleport poll = server
   tap; legs 6-10; loop wall=…s)`; set this task's steps + TASK-95.1 `passes` in
   `.ralph/tasks.json`; LOG entry; delete this handoff in that commit.
   TASK-95.2 (docs + full gate + close-out) comes next.

## Working tree

- Committed this iteration (`4fcdc91`): `app/tests/e2e/touch-loop.spec.ts`
  (all four fixes above). Everything else dirty in `git status` is PRE-EXISTING
  (screenshots, `.ralph/prd/PRD.md`, `.ralph/decisions.jsonl`, `.gitignore`,
  `ralph.config.json`, `app/.ralph/`, `app/.trace-tmp/`, untracked TASK-89..92
  specs) — NOT this task's, do not commit. `app/test-results/` = scratch.

## How to verify

- `cd app && npx tsc --noEmit` — green at this handoff.
- `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line`
  — runs 10/12/13: legs 1–8 green (land probe docked 1.0 m), leg 9 re-enter red
  (pre-`reEnterShip`); the `reEnterShip` fix is applied but unverified.
