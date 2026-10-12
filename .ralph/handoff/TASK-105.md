# TASK-105 handoff — Surface egress: exit a landed ship anywhere (not only on a dock)

## Status

Server, client, and unit/shard/ws test work for TASK-105 is COMPLETE and green (tsc clean, 21/21 in the touched unit test files). What remains: the E2E spec `app/tests/e2e/surface-egress.spec.ts` (not yet written), its run + screenshot, the full `npm run test` pass, lint/format, and the final `feat(TASK-105): ...` commit. Estimated ~30–45 min.

## Done

All product code + unit/shard/ws tests implemented (uncommitted, in working tree):

- `app/src/shared/interaction.ts` — added `EXIT_SHIP_MAX_SPEED = 2` next to `ENTER_SHIP_MAX_SPEED`.
- `app/src/server/shard/shard.ts` —
  - `canExitShip` pure helper (~line 4174): `canExitShip({padId, docked, regime, speed})` returns `'docked' | 'landed' | 'not-landed'` — padId ⇒ `'docked'`; `entity.docked` flag (home-dock/respawn starter ship) ⇒ `'not-landed'`; regime `'surface'` && speed < 2 ⇒ `'landed'`; else `'not-landed'`.
  - `ExitShipOutcome` extended with `'not-landed'`; `handleExitShip` (~line 2716) reworked: pad-docked path byte-for-byte unchanged (padId ⇒ pad-plane spawn); new surface path spawns the character via `characterSpawnPos` at `shard.terrainHeightAt(planetId, x, z)` (terrainHeightAt is at line 1010); denial `{code: 'not-landed'}` sent to the requesting conn for airborne/space/moving ≥ 2 u/s.
- `app/src/client/state/exit-ship.ts` (new) + `app/src/client/state/exit-ship.test.ts` (new) — store with `canExitLanded(regime, speed)` / `canExitShip()` / `setCanExitShip(v)`, following the `docked.ts` subscribe/emit idiom.
- `app/src/client/main.tsx` — 3 edits: imports (`canExitLanded, canExitShip, setCanExitShip`, `vecLength`); self `entity_update` wiring (~line 486: `self.kind === 'ship' && canExitLanded(flightRegime, |vel|)` — normalize omitted `vel` at rest to {0,0,0}); `interactPress` (~line 1419) fires `exit_ship` when `dockedIndicator() || canExitShip()`.
- `app/src/client/ui/leave-ship-prompt.tsx` + `.test.tsx` — prompt renders when docked OR can-exit; text "LEAVE SHIP" kept for both; docked/landed/unmount cases covered.
- `app/src/server/shard/shard.character.test.ts` — old exit-denial test now expects `'not-landed'`; 2 new shard tests (off-pad exit spawns character at terrain height; grounded-but-fast ship denied) + pure-helper describe. 12/12 pass.
- `app/src/server/galaxy/exit-ship.ws.test.ts` — `findPadTarget` now returns planetId; denial test now `'not-landed'`; new ws test (landed off-pad exit + character at terrain height ±0.5 + re-entry). 3/3 pass.

Design notes carried from the session (already reflected in code):
- Wire: `flightRegime` = regime-machine regime (space/atmosphere/surface); `regime` field = `'docked'` when `docked || onPad || padId`. Ship `vel` is omitted at rest — normalize to {0,0,0} before computing speed.
- Old pre-task denial code `'not-docked'` for exit_ship was REPLACED by `'not-landed'` (spec defines the new code); the two asserting tests were updated.
- Home-dock starter ship (docked flag, no padId, flight regime `'space'`) is intentionally denied (`'not-landed'`) — that path's behavior is unchanged in spirit.
- Regime machine settles a ship at rest on terrain to `'surface'` within a couple of ticks; pad machine has 20 m acquire / 25 m release hysteresis, so ~100 m off-pad ⇒ no padId.

Verified at 02:19: `npx tsc --noEmit` exit 0; `npx vitest run src/server/shard/shard.character.test.ts src/server/galaxy/exit-ship.ws.test.ts src/client/state/exit-ship.test.ts src/client/ui/leave-ship-prompt.test.tsx` → 4 files, 21 tests, all pass.

## Working tree

NOT committed — everything below sits uncommitted in /workspace/master (commit `wip(TASK-105): ...` was planned but the session ended before it; stage only these paths, see Next steps):

- Modified (task files): `app/src/shared/interaction.ts`, `app/src/server/shard/shard.ts`, `app/src/server/shard/shard.character.test.ts`, `app/src/server/galaxy/exit-ship.ws.test.ts`, `app/src/client/main.tsx`, `app/src/client/ui/leave-ship-prompt.tsx`, `app/src/client/ui/leave-ship-prompt.test.tsx`
- New (task files): `app/src/client/state/exit-ship.ts`, `app/src/client/state/exit-ship.test.ts`, `.ralph/handoff/TASK-105.md`
- NOT part of the task (pre-existing dirt — do NOT commit): ~90 modified `.ralph/screenshots/*.png`, `.gitignore`, `.ralph/prd/PRD.md`, `.ralph/tasks.json`, `ralph.config.json`, untracked `.ralph/tasks/TASK-*.json`, `.agents/`, `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `app/.ralph/`, `app/.trace-tmp/`.

Build state: tsc green, touched unit tests green (see above). E2E for this task has NOT been run (spec doesn't exist yet). No background processes were left running.

## Next steps

1. Write `app/tests/e2e/surface-egress.spec.ts` (pattern: `app/tests/e2e/enter-ship.spec.ts` — inline `RawWsClient`, `PROTOCOL_VERSION = 1`, imports ONLY from `./fixtures` and `./helpers`; e2e specs cannot import app/src because Playwright doesn't resolve tsconfig aliases):
   - claim via `POST /api/callsigns` → `dockAtPad` (raw WS: hello/auth/join_system, `POST /api/dev/teleport` to `pad.y + 5`, wait for `entity_update` with `regime === 'docked' && padId === target.padId`, close raw client).
   - Browser: goto, `#docked-indicator` visible → press E (pad path exits, sanity) OR simpler: after dock, `POST /api/dev/teleport` the SHIP to `{x: pad.x + 100, y: pad.y, z: pad.z}` (flat terrain — pad.y is a valid ground proxy for terrain height here; the dev teleport API is at `app/src/server/routes/dev.ts`), wait for self `entity_update` with `padId` absent and `flightRegime === 'surface'`.
   - Assert `#docked-indicator` hidden, `#leave-ship-prompt` visible → press E → on-foot: `#hazard-hud` visible, `window.__CHAR__.pos` (server-authoritative 10 Hz probe) within ~2 m of ship y and ~2.5 m horizontally beside the ship → screenshot to `.ralph/screenshots/TASK-105-1.png` ("on foot next to landed ship").
   - Re-entry: reuse the turn-burst loop from `enter-ship.spec.ts` ('d' 100 ms bursts + 400 ms rest until `#interact-prompt` text === '[E] Enter ship', 24 iterations), press E → `#leave-ship-prompt` + `#docked-indicator`... note: after off-pad re-entry the ship is NOT pad-docked, so assert `#leave-ship-prompt` visible and `#docked-indicator` behavior per the new store logic (leave-ship prompt now shows when canExitShip too — assert accordingly, don't copy the docked-indicator expectation blindly).
2. Run: `cd app && npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts disembark.spec.ts docked-indicator.spec.ts` (the spec's "exit-ship.spec.ts" IS `disembark.spec.ts` in e2e). Optionally add `enter-ship.spec.ts`.
3. Full `cd app && npm run test` (~2 min), then `eslint --fix` + `prettier --write` on the 9 touched files, final `npx tsc --noEmit`.
4. Bookkeeping: flip `passes: true` for TASK-105 in `.ralph/tasks.json` (~line 925); add `.ralph/logs/LOG.md` entry NEWEST-FIRST (2026-10-12, summary, screenshot path, Tasks Completed 122 → 123); this handoff file can be deleted at that point.
5. Commit ONLY the task paths listed in Working tree + the e2e spec + `.ralph/screenshots/TASK-105-1.png` as `feat(TASK-105): surface egress — exit a landed ship anywhere`.
6. Output `<promise>TASK-105:DONE</promise>`.

## Dead ends

- Nothing hard. Minor: `exit-ship.ws.test.ts` has a documented load-flake ("timed out waiting for self entity_update") — if it goes red under the full parallel suite, re-run in isolation; it was green standalone.
- e2e cannot call `terrainHeightAt` (no app/src imports) — resolve by asserting char.y ≈ ship.y ± ~2 m (both grounded) rather than an absolute terrain value; the pad area is flat so `pad.y` works as the teleport ground height.

## How to verify

```bash
cd /workspace/master/app
npx tsc --noEmit
npx vitest run src/server/shard/shard.character.test.ts src/server/galaxy/exit-ship.ws.test.ts src/client/state/exit-ship.test.ts src/client/ui/leave-ship-prompt.test.tsx   # expect 21/21
npm run test    # full suite
npx playwright test --config playwright.e2e.config.ts surface-egress.spec.ts disembark.spec.ts docked-indicator.spec.ts   # after writing the e2e spec
```
