# TASK-105 handoff — Surface egress: exit a landed ship anywhere (not only on a dock)

## Status

Product code + all unit/shard/ws tests are COMPLETE and committed (c1c6f84). The e2e spec
`app/tests/e2e/surface-egress.spec.ts` is written and PASSES through the on-foot state
(dock → off-pad teleport → landed-gate prompt → E disembarks → character 2.5 m beside the
ship on terrain height → screenshot). The only remaining failure is the RE-ENTRY step: the
on-foot interaction raycast (`__INTERACT__`) never resolves the ship — all 24 turn bursts
return null even though the server-authoritative character is 2.92 m from the ship and the
server rot sweep covers the ship's bearing. Root cause not yet found; instrumentation was
just added and NOT yet run.

## Done

This session (on top of the previous handoff, whose product work is committed as c1c6f84):

- Wrote `app/tests/e2e/surface-egress.spec.ts` (imports only `./fixtures`, `./helpers`,
  `./raw-ws`):
  - `dockAtPad`: raw WS hello/auth/join_system (+warp if needed), `POST /api/dev/teleport`
    to `pad.y + 5`, wait `entity_update` regime 'docked' + padId, close raw client.
  - Browser: goto, assert pre-state `#docked-indicator` + `#leave-ship-prompt` visible.
  - Teleport the SHIP to `{x: pad.x + 100, y: pad.y + 5, z: pad.z}` — the +5 is REQUIRED
    (see Dead ends: terrain at pad.x+100 is ~2.6 m HIGHER than pad.y; a pad-height drop
    buries the ship). The ground clamp settles it on terrain, pad machine releases (25 m
    hysteresis), regime → 'surface'.
  - Wait `window.__SELF_SHIP__.probe().pos` within 5 m of the target; assert
    `#docked-indicator` HIDDEN and `#leave-ship-prompt` VISIBLE (the new landed gate).
  - Capture shipPos from the same probe; press E; assert prompt hidden, indicator hidden,
    `#weight-bar` visible (NOT `#hazard-hud` — that only mounts inside a hazard zone).
  - Geometry via `window.__CHAR__` (server-authoritative 10 Hz): |char.y − ship.y| < 3 and
    horizontal distance 1.5–3.5 m (the 2.5 m `CHAR_SHIP_SIDE_OFFSET_M`).
  - Screenshot `.ralph/screenshots/TASK-105-1.png` (EXISTS — verified on-foot view).
  - Re-entry: 24× ('d' 100 ms burst + 400 ms rest, break on '[E] Enter ship'), then
    `toHaveText('[E] Enter ship')` — **THIS IS WHERE IT FAILS** — then E and assert
    `#docked-indicator` hidden + `#leave-ship-prompt` visible (off-pad re-entry: the ship
    is NOT pad-docked, so the leave-ship prompt comes back from the landed gate alone).
  - Second screenshot planned: `TASK-105-2.png` (only saved after re-entry succeeds).

- Debug instrumentation in place (all marked `TEMP DEBUG`, must be stripped before the final commit):
  - `app/src/client/interact-debug.ts` — `InteractDebugState` gained `targets?: unknown`
    (the raycast's target list) and `facing?` (the predicted quat) fields (lines 19–22).
  - `app/src/client/main.tsx` (~line 1810) — assignments for both fields, INSIDE the
    `if (raw)` hit branch of the per-frame raycast (lines ~1786–1835). **BUG IN MY
    INSTRUMENTATION: because it sits in the hit branch, it never fires when raw is null —
    which is exactly the failing case. Move the two assignments to the TOP of the raycast
    section (right after `resolveInteract`, before `if (raw)`) so the null case is captured.**
  - `app/tests/e2e/surface-egress.spec.ts` — a `console.log` probe per burst (reads
    `__INTERACT__` + `__CHAR__.rot`) in the turn loop and a `dbg` evaluate + log right
    before the re-entry `toHaveText`. Strip both before the final commit.

Verified facts from the failing runs (seed DRIFT-SEED-0001, system 7df0ed2af70ae07a):
- Server char pos (10260, 291.5, 162.5), ship pos (10260, 290, 160) → distance 2.92 m,
  WITHIN the 5 m ship enter radius (`ENTER_SHIP_RANGE_M`).
- `__CHAR__.rot` (server rot) sweeps ALL bearings across the 24 bursts (≈ full revolution:
  quat y goes −0.68 → −0.98 → −0.09 → 0.98 → … — the input IS reaching the server,
  acked seq climbs to 441).
- `__INTERACT__` stays `{text:null, targetId:null, distance:null, feet:null}` every burst —
  the raycast returns null every frame.
- The raycast (main.tsx ~1786) is anchored on the PREDICTED state (`st.pos`, `st.quat`
  from CharacterPredictor, src/client/net/character-prediction.ts), NOT the server state —
  so a predicted-pose divergence (pos > 5 m away, or facing never rotating) would produce
  exactly this signature. The target list is `interactableTargetsRef.current`, fed from
  every entity_update batch (main.tsx ~1212) via `interactableTargetsFrom`; ship
  eligibility is `target.callsign === ctx.callsign` with
  `ctx.callsign = sessionCallsignRef.current` (interaction.ts `createInteractableRegistry`).
  The same code path works on the pad (enter-ship.spec.ts is green), so the suspect is the
  predicted state or the target list in THIS scenario, not the registry math.

## Working tree

- COMMITTED in c1c6f84 (`wip(TASK-105): server/client egress work complete + unit tests
  green; e2e spec and final commit pending`): all product code + unit/shard/ws tests
  (interaction.ts, shard.ts, shard.character.test.ts, exit-ship.ws.test.ts, main.tsx,
  state/exit-ship.ts + test, leave-ship-prompt.tsx + test). tsc was green at commit time.
- UNCOMMITTED this session (task paths — stage these):
  - `app/tests/e2e/surface-egress.spec.ts` (NEW)
  - `app/src/client/interact-debug.ts` (TEMP DEBUG fields)
  - `app/src/client/main.tsx` (TEMP DEBUG assignments)
  - `.ralph/handoff/TASK-105.md` (this file)
  - `.ralph/screenshots/TASK-105-1.png` (NEW — on-foot next to the landed ship; commit it)
- NOT part of the task (pre-existing dirt — do NOT commit): `.gitignore`,
  `.ralph/prd/PRD.md`, `.ralph/tasks.json`, `ralph.config.json`, ~90 modified
  `.ralph/screenshots/*.png`, untracked `.agents/`, `.gitattributes`,
  `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `.ralph/tasks/TASK-*.json`,
  `app/.ralph/`, `app/.trace-tmp/`.
- No background processes left running (the e2e fixture boots/tears down its own dev server).

## Next steps

1. Fix the instrumentation bug: in `app/src/client/main.tsx`, move the two TEMP DEBUG
   assignments OUT of the `if (raw)` block to right after the `resolveInteract(...)`
   call (~line 1792) so they capture the null case (the target list + predicted quat +
   also log `st.pos` if you want the predicted feet — add a TEMP field for it).
2. Run: `cd app && npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts`
   and read the per-burst console output (targets + facing + server rot). Diagnose:
   - Ship MISSING from `targets` → entity_update feed or the ship's wire callsign.
   - Ship present, `facing` rotating, but no hit → predicted `st.pos` is > 5 m from the
     ship (check CharacterPredictor reconcile, src/client/net/character-prediction.ts;
     compare predicted pos vs `__CHAR__.pos`).
   - `facing` NOT rotating → predicted quat stuck (turn input not integrated client-side).
3. Fix the root cause (client side; the server gate is proven by the committed ws/shard tests).
4. STRIP ALL TEMP DEBUG: interact-debug.ts fields, main.tsx assignments, the spec's
   console.log probe in the burst loop and the `dbg` evaluate block.
5. Re-run the spec to green, then the full set:
   `cd app && npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts disembark.spec.ts docked-indicator.spec.ts enter-ship.spec.ts`
6. `cd app && npx tsc --noEmit`; full `npm run test`; `eslint --fix` + `prettier --write`
   on all touched files (the 9 product files + the spec + interact-debug.ts if it stays modified).
7. Bookkeeping: flip `passes: true` for TASK-105 in `.ralph/tasks.json` (~line 925); add a
   NEWEST-FIRST entry to `.ralph/logs/LOG.md` (2026-10-12, summary,
   `.ralph/screenshots/TASK-105-1.png`, Tasks Completed 122 → 123); delete this handoff.
8. Commit ONLY the task paths + spec + screenshots as
   `feat(TASK-105): surface egress — exit a landed ship anywhere`.
9. Output `<promise>TASK-105:DONE</promise>`.

## Dead ends

- `#hazard-hud` as the on-foot-HUD marker: it only mounts inside a hazard zone (rad zone /
  storm), not on open terrain → use `#weight-bar` (always-rendered on-foot node).
- Teleporting the ship at `pad.y` (the previous handoff's "flat terrain, pad.y = ground
  proxy" assumption): the terrain at pad.x+100 is ~2.6 m HIGHER than pad.y on this seed →
  the ship sinks into terrain, Δy 2.56 > tolerance, and the "ship pose" probe reads the
  buried position. Teleport at `pad.y + 5` and let the ground clamp settle the ship.
- Copying enter-ship.spec.ts's re-entry expectations verbatim: after OFF-PAD re-entry the
  ship is NOT pad-docked — `#docked-indicator` stays hidden; the leave-ship prompt comes
  back from the landed gate (`canExitShip`) alone. (Already handled in the spec.)
- UNRESOLVED (the open problem): the raycast never resolves the ship 2.92 m away during a
  full-rotation sweep. The server-side state is proven correct by the debug dumps; the
  predicted-state / target-list instrumentation (once the null-case capture bug is fixed)
  should isolate it in one run.

## How to verify

```bash
cd /workspace/master/app
npx tsc --noEmit
npx vitest run src/server/shard/shard.character.test.ts src/server/galaxy/exit-ship.ws.test.ts src/client/state/exit-ship.test.ts src/client/ui/leave-ship-prompt.test.tsx   # was 21/21 green at c1c6f84
npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts
npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts disembark.spec.ts docked-indicator.spec.ts enter-ship.spec.ts
npm run test
```
