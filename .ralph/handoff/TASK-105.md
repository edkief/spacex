# TASK-105 handoff — Surface egress: exit a landed ship anywhere (not only on a dock)

## Status

BOTH root causes found and fixed (product + spec), all 4 relevant e2e specs green in TWO
consecutive combined runs; tsc + the 2 interaction unit-test files green. What remains is
verification sweep + bookkeeping + final commit: full `npm run test`, eslint/prettier on the
touched files, one more e2e confirmation run (ideally including `interact.spec.ts` /
`mining.spec.ts` / `inventory.spec.ts` to prove the cone change regresses nothing), flip
`passes: true`, LOG.md entry, delete this handoff, final commit.

## Done

This session (all UNCOMMITTED — see Working tree):

1. **ROOT CAUSE #1 (the null raycast from the previous handoff) — found and fixed.**
   Fixed the instrumentation bug first (TEMP DEBUG assignments moved out of the `if (raw)`
   hit branch in `app/src/client/main.tsx`, so the null case is captured) and ran the
   instrumented spec. The dump was decisive: the ship IS in the target list
   (`{id:'8414…', kind:'ship', pos:{x:10260,y:290,z:160}, callsign:matches, docked:false}`),
   the predicted feet are at the server char pos `{x:10260,y:291.5,z:162.5}`, and `facing`
   sweeps ALL bearings across the 24 bursts — yet `nearestInteractable` returns null every
   frame. The ship is 2.92 m away (inside the 5 m enter radius), so the failure was the
   CONE, not range, targets, or the predictor.
   **Geometry:** the landed ship's wire `pos` sits on the terrain AT THE SHIP'S (x,z)
   (y=290), while the character is spawned on the terrain at the ship's SIDE offset
   (2.5 m away, y=291.5) — on this seed the terrain slope over 2.5 m is 1.5 m, i.e. the
   ship is **30.96° below the character's horizontal forward axis**. The old
   `interactConeAngle` was a 3-D pitch angle between the yaw-only (strictly horizontal)
   forward vector and the 3-D target direction — 30.96° > 30° cone → never in cone at any
   facing. On a pad the ship's wire pos is at pad height (Δy ≈ 0), which is why
   enter-ship.spec.ts was always green.
   **Fix (product, client-side math only):** `app/src/shared/interaction.ts` —
   `interactConeAngle` now computes the HORIZONTAL BEARING angle (XZ projection of
   forward and target direction). The vertical offset stays bounded by the 3-D distance
   cap (the range check is unchanged 3-D). The SERVER never used the cone (it validates
   only 3-D range ≤ 5 m — confirmed: no `inInteractCone`/`interactConeAngle` references in
   src/server), so this changes zero server behavior. Removed the now-unused `vecDot`
   import. Updated the module doc comment (TASK-105 note) and the function doc.
   **Test:** new `it` in `app/src/shared/interaction.test.ts` ("TASK-105: the cone is a
   horizontal BEARING — vertical offset is out of scope") pinning the exact egress
   geometry (1.5 m below at 2.5 m ahead = 0° bearing, in cone), 40° off bearing = out,
   straight overhead = 0°. All pre-existing cone tests still pass (they used y=0 or
   angles >30° in bearing too; the (1,1,1) "excluded" case is 45° in bearing).
   40/40 green in interaction.test.ts (shared) + interaction.test.ts (client).

2. **ROOT CAUSE #2 (re-entry flake in combined runs) — found and fixed.**
   After fix #1, surface-egress passed STANDALONE (18.7 s) but failed 2/2 in the combined
   4-file run — E after the prompt showed never re-entered the ship. Instrumented the
   E press (pre-enter `__CHAR__`/`__SELF_SHIP__` dump + full console capture, both since
   stripped): in the failed run `__CHAR__.rot` was **absent**. `entityToState`
   (shard.ts ~4300) OMITS `rot` when the quat is identity → the server character had
   rotated back to identity (+Z), which is 180° from the ship's −Z bearing → out of cone →
   raycast null → `resolvedTargetRef` cleared by the debounce → E silently no-opped. The
   character had rotated PAST the ship (the held-'d' keyup can lag the busy software-GL
   main thread — the known enter-ship.spec.ts lesson), and the ship sits at the CONE EDGE
   (27° off on the passing seed), so one 10 Hz reconcile wobble clears the dispatch
   target mid-press. Two fixes:
   - **Product hardening:** `app/src/client/main.tsx` — `INTERACT_HOLD_FRAMES = 3` → `30`
     (~500 ms, spans a full 10 Hz reconcile cycle with margin). Nothing else references
     the constant (grep-verified); no test pins the value. Comment updated to explain.
   - **Spec robustness:** `app/tests/e2e/surface-egress.spec.ts` — the re-entry section is
     now a RETRY loop: 24× (burst 'd' 100 ms + 300 ms rest → if '[E] Enter ship' shows,
     press E, wait 600 ms → break when `#leave-ship-prompt` is visible = re-entered).
     Post-state asserts: `#leave-ship-prompt` visible (the landed gate, off-pad),
     `#interact-prompt` hidden, `#docked-indicator` hidden, screenshot TASK-105-2.png.

3. **Spec geometry tolerance (seed-dependent flake, separate from the raycast):**
   a combined run failed `Δy < 3` with 3.30 m (terrain at ship pos vs 2.5 m to its side
   can differ by a few metres: integer-metre heightmap cells on a 5 m grid, hilly
   terrain). Replaced with: horizontal side offset 1.5–3.5 m (unchanged), Δy < 4 (sanity:
   on the terrain, not buried/floating), and the BINDING invariant: 3-D distance
   char↔ship < 5 m (the enter-ship radius re-entry actually needs).

4. **Stripped ALL TEMP DEBUG/DIAG** (the fields in `app/src/client/interact-debug.ts` are
   gone — file is back to its pre-instrumentation shape; the main.tsx assignments, the
   spec's per-burst console probe, the `dbg` evaluate, the pre-enter dump, and the
   CONSOLE-TAIL capture are all removed).

5. **Verified:** tsc --noEmit green. e2e combined set
   `surface-egress disembark docked-indicator enter-ship` — **4/4 green in TWO
   consecutive runs** (1.3 m each); the same set was 3/4 (surface-egress failing at
   re-entry) in 2 of 2 runs before the fix. Screenshot TASK-105-2.png (post re-entry,
   cockpit with the leave-ship prompt) was captured in the green runs.

## Working tree

- COMMITTED (c1c6f84 + 5c22f80): all product code + unit/shard/ws tests, the e2e spec,
  and the (now-stripped) instrumentation. The spec committed in 5c22f80 is the
  PRE-fix version (old Δy<3 assert, no re-entry retry).
- UNCOMMITTED this session (task paths — stage these):
  - `app/src/shared/interaction.ts` (bearing-cone fix — THE product fix)
  - `app/src/shared/interaction.test.ts` (new bearing-cone test)
  - `app/src/client/main.tsx` (TEMP DEBUG stripped + INTERACT_HOLD_FRAMES 3→30 + comment)
  - `app/src/client/interact-debug.ts` (TEMP DEBUG fields removed — back to clean shape)
  - `app/tests/e2e/surface-egress.spec.ts` (TEMP DIAG stripped, Δy tolerance +
    3-D < 5 m assert, re-entry retry loop)
  - `.ralph/screenshots/TASK-105-1.png` (modified — on-foot next to the landed ship)
  - `.ralph/screenshots/TASK-105-2.png` (NEW — cockpit after off-pad re-entry)
  - `.ralph/handoff/TASK-105.md` (this file)
- NOT part of the task (pre-existing dirt — do NOT commit): `.gitignore`,
  `.ralph/prd/PRD.md`, `.ralph/tasks.json`, `ralph.config.json`, ~90 modified
  `.ralph/screenshots/*.png` (other tasks), untracked `.agents/`, `.gitattributes`,
  `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`,
  `.ralph/tasks/TASK-*.json`, `app/.ralph/`, `app/.trace-tmp/`.
- Builds: `npx tsc --noEmit` green at last check. No background processes (the e2e
  fixture boots/tears down its own dev server tree).

## Next steps

1. `cd app && npm run test` (FULL unit suite — only the 2 interaction files were re-run
   this session; nothing references INTERACT_HOLD_FRAMES, but run the whole thing).
2. `cd app && npx eslint --fix` + `npx prettier --write` on the 5 touched code files.
3. Final e2e confirmation — the relevant set:
   `npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts disembark.spec.ts docked-indicator.spec.ts enter-ship.spec.ts`
   PLUS the other interact-prompt specs, to prove the bearing-cone change regresses
   nothing (it makes the cone MORE permissive vertically — targets above/below the
   character are now reachable on bearing alone, range still 3-D-capped):
   `npx playwright test --config playwright.e2e.config.ts interact.spec.ts mining.spec.ts inventory.spec.ts`
   (all 5 ship/egress specs already ran 4/4 green twice this session).
4. Bookkeeping: flip `passes: true` for TASK-105 in `.ralph/tasks.json` (~line 925); add
   a NEWEST-FIRST entry to `.ralph/logs/LOG.md` (2026-10-12, summary: egress off-pad —
   server gate + landed leave-ship prompt + re-entry; the cone fix (interaction.ts
   bearing cone) + the debounce hardening (INTERACT_HOLD_FRAMES 3→30); screenshots
   `.ralph/screenshots/TASK-105-1.png` + `-2.png`; Tasks Completed 122 → 123);
   delete this handoff in the same commit.
5. Commit ONLY the task paths listed in Working tree as
   `feat(TASK-105): surface egress — exit a landed ship anywhere`.
6. Output `<promise>TASK-105:DONE</promise>`.

## Dead ends

- `#hazard-hud` as the on-foot-HUD marker: it only mounts inside a hazard zone →
  `#weight-bar` (always-rendered on-foot node). (from previous handoffs)
- Teleporting the ship at pad.y: the off-pad terrain can sit ~2.6 m ABOVE pad.y on this
  seed → the ship sinks; teleport at pad.y + 5 and let the ground clamp settle it.
- Δy < 3 as the on-foot geometry tolerance: seed-dependent (3.3 m observed) — use
  Δy < 4 + the binding 3-D < 5 m re-entry radius instead.
- The old 3-D pitch cone for a yaw-only character (the actual root cause #1): a target
  whose wire pos is a metre+ below the terrain feet is unreachable at EVERY facing when
  the slope angle exceeds the cone. The fix is the horizontal bearing cone — do NOT
  "fix" this by lowering the cone angle, raising the spawn height, or anchoring the
  cone at the character's head: the server range check is feet-anchored 3-D and the
  bearing cone matches the yaw-only model exactly.
- Debounce of 3 frames (50 ms) for a cone-edge target (root cause #2): one 10 Hz
  reconcile wobble (or a lagged keyup that rotates the character past the ship) clears
  the dispatch target between prompt-visible and the E press. 30 frames (~500 ms) +
  the spec's E-retry loop made it deterministic in 4/4 combined runs.
- Do NOT assume `__CHAR__.rot` is always present: `entityToState` omits identity quats
  — read `rot ?? identity` in any probe (the spec's probe already tolerates it).

## How to verify

```bash
cd /workspace/master/app
npx tsc --noEmit
npm run test
npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts disembark.spec.ts docked-indicator.spec.ts enter-ship.spec.ts
npx playwright test --config playwright.e2e.config.ts interact.spec.ts mining.spec.ts inventory.spec.ts
npx vitest run src/shared/interaction.test.ts src/client/input/interaction.test.ts   # 40/40 green this session
```
