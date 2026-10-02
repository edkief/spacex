# Handoff: TASK-34

## Status

Implementation and ALL tests are done and green. Only close-out bookkeeping
remains: a LOG.md entry, `passes: true` in `.ralph/tasks.json` (+ its 4 steps),
deleting this handoff file, and the final commit.

## Done

This iteration (on top of commits 5c20895 + a0a4ff7 from iteration 19):

1. **Fixed `app/src/server/shard/persist.test.ts` (was 11 failures)** — single
   root cause, not eleven: the "empty shard" test expected
   `{ saved: 0, destroyed: 0, ms: 0 }` but `FlushSummary` now carries
   `inventories` (added in the WIP commit) → the expectation threw BEFORE
   `spy.mockRestore()`, leaking the `repo.withTransaction` spy into every
   later test (that is the `RangeError: Maximum call stack size exceeded` at
   line 102 — each subsequent test's `original` captured the LEAKED spy).
   Fix (committed as `ea8afaf`): added `inventories: 0` to the two
   `toEqual` summary expectations (was lines 76 and 278) + wrapped the
   "upserts … ONE transaction" test's flush in try/finally so the spy is
   always restored. All 14 tests in the file now pass.
2. **NEW `app/tests/e2e/inventory.spec.ts`** (Playwright, self-contained
   TASK-70 harness pattern copied from `interact.spec.ts`) — GREEN (8.1 s).
   Server-side: claim → `/api/dev/pad-target` → join/warp → `/api/dev/teleport`
   onto the pad → dock → `exit_ship` disembark over raw WS →
   `POST /api/dev/give {resourceId:'iron', amount:8}` → close raw client
   (inventory lives on the shard player entity, survives the disconnect).
   Browser: same session → on foot → `#weight-bar` visible with `8/40u` →
   hover shows `iron x8 (8u)` → press Q (the client's real drop path) → bar
   becomes `7/40u` + hover `iron x7 (7u)` → console clean.
   Screenshot `.ralph/screenshots/TASK-34-2.png` shows the bonus: the
   dropped ground item is at the character's feet AND inside the raycast, so
   the `[E] Take iron x1` prompt appears bottom-center (TASK-33 registry
   entry working end-to-end).
3. **Verified green**: full unit suite `npm run test` — 104 files,
   898 passed / 1 skipped (899); `npx playwright test --config
   playwright.e2e.config.ts inventory.spec.ts` — 1 passed; `tsc --noEmit`
   clean; eslint + prettier clean on both touched files (prettier: no
   changes needed).

From iteration 19 (already committed, all still green): inventory model +
`parseInventoryJson` in `src/shared/inventory.ts`, shard pickup/drop +
`syncCharacterInventory` + `giveInventoryForTesting`, dev route
`POST /api/dev/give` (`src/server/routes/dev.ts`), `WeightBar`
(`src/client/ui/weight-bar.tsx`), Q-key drop in `main.tsx`, client
state `src/client/state/inventory.ts`, repo `getPlayerInventory` /
`updatePlayerInventory` + players.inventory migration,
`shard.inventory.test.ts` (9) + `inventory.ws.test.ts` (2).

## Working tree

- Committed: `ea8afaf fix(shard): persist.test.ts — inventories summary
  field + spy-leak guard` (everything else committed in a0a4ff7 / 5c20895).
- Uncommitted: NEW `app/tests/e2e/inventory.spec.ts` (e2e-verified green) +
  this handoff file. Screenshots `TASK-34-{1,2}.png` exist on disk but are
  gitignored (`.gitignore:16 .ralph/screenshots/*.png` — project convention).
- Builds: yes — tsc clean, full unit suite green, e2e spec green.

## Next steps

Nothing technical remains. Close out, in order:
1. `.ralph/tasks/TASK-34.json` (the spec file): set all four step `pass`
   flags true.
2. `.ralph/tasks.json` line ~365: TASK-34 `"passes": false` → `true`.
3. `.ralph/logs/LOG.md`: add a new entry at the TOP (under `### 2026-10-02 —
   TASK-33…`) summarizing the above (model/parse fix, character-inventory
   sync, dev /give, WeightBar + Q-drop, 9+2 unit/WS tests, persist.test
   spy-leak fix, e2e spec), with screenshot paths
   `.ralph/screenshots/TASK-34-1.png` / `TASK-34-2.png`. Follow the existing
   entry format; also bump the "Tasks Completed" counter at the top.
4. Delete `.ralph/handoff/TASK-34.md`.
5. Commit everything with a Conventional Commit message
   (e.g. `feat(inventory): TASK-34 on-foot inventory — weight-capped
   carry, drop/pickup, persistence, weight bar (HUD)`).
6. Output `<promise>TASK-34:DONE</promise>` and stop.

## Dead ends

- `expect(page).toHaveText('iron x8 (8u)')` on the whole page fails — it
  matches the ENTIRE page text exactly. Use `expect(bar).toContainText(…)`
  scoped to the `#weight-bar` locator (fixed in the committed spec).
- The 11 persist.test.ts failures look like 11 bugs but are one: a leaked
  `vi.spyOn(repo, 'withTransaction')` from the first failing test. Never
  `mockRestore()` after an unguarded expectation that can throw.

## How to verify

Follow the task spec (`.ralph/tasks/TASK-34.json`). Quick re-verify:
`cd app && npm run test` (expect 898 passed / 1 skipped),
`npx playwright test --config playwright.e2e.config.ts inventory.spec.ts`
(boots its own server via fixtures.ts — no `npm run dev` needed),
`npx tsc --noEmit`.
