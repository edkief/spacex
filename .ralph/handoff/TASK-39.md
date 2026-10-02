# Handoff: TASK-39 — Cargo hold model with transfer rules

## Status

TASK-39 is functionally complete and all of its new tests pass individually; what remains is a
short close-out (full-suite green check, flags, LOG, delete this handoff, commit, promise).
Nothing is left to implement.

## Done

Commits:
- `768ea06` (prior iteration): the whole implementation — `src/shared/cargo.ts` (CargoHold,
  `cargoCapacityFor` = cargoSlots×10: scout 40 / interceptor 20 / freighter 120, atomic
  `transferCargo`, `parseCargoJson`/`sanitizeCargo`), migration `000004_ship_cargo.sql`
  (ships.cargo JSON, COALESCE upsert), shard `handleCargoOpen`/`handleCargoTransfer` +
  interact 'open-cargo' (not-owner) + `getCargo`, router warp writes the source hold into the
  ship row, client cargo panel + ship-HUD CARGO button + ship prompt sub-zones (≤3 m Enter /
  3–5 m Open cargo), 19 shared unit tests, tsc clean.
- `212b434` (this iteration):
  - **Bug found + fixed (warp cargo):** router.ts called `adoptEntity` (reads the STALE row —
    flush period behind) BEFORE writing the fresh hold via `saveShipState`; the target entity
    kept the stale cargo and its next flush would wipe the fresh row. Fix: `if (cargo)
    entity.cargo = cargo;` right after adopt (comment in router.ts ~line 388).
  - New `app/src/server/shard/shard.cargo.test.ts` (9 tests, green): open in-ship (hold-only,
    requester-only), open on-foot (hold+inventory), not-docked, out-of-range, transfer ladder
    (wrong-regime / not-docked / out-of-range / invalid-resource / invalid-amount), atomic
    load (frame + entity + 'cargo-transfer' event + character mirror), PARTIAL at the 40 u cap
    (39 loaded → request 5 moves exactly 1, then 'insufficient'), unload (bounded by stow AND
    the 40 u inventory cap), interact 'open-cargo' on another player's ship → not-owner.
  - `app/src/server/shard/persist.test.ts` +2 tests (green): cargo rides ships.cargo (a
    cargo-less flush never wipes it), restart round trip (flush → row → new SystemShard
    `loadShips` → entity.cargo {iron:10, crystal:1}, 13 u, capacity 40).
  - New `app/src/server/galaxy/cargo.ws.test.ts` (2 live-ws tests, green): transfer round
    trip + insufficient + not-docked (via `shard.entities.get(shipId)!.padId = undefined` —
    safe: the tick does NOT re-check pads while the owner is on foot, shard.ts ~line 705) +
    two-player isolation (interact open-cargo → not-owner, no 'cargo' frame leak to A) +
    wrong-regime; warp round trip (load 10 iron, warp A→B, hold still 10 — exercises the
    router fix above).
  - New `app/tests/e2e/cargo.spec.ts` (green, 23.5 s, first run): raw-WS claim → pad → dock →
    give 10 iron → browser in-ship: #ship-hud-cargo → panel hold-only + hint → Esc → E
    disembark → hold 'd' to turn toward the ship (polls #interact-prompt for '[E] Enter ship')
    → 's' back into the 3–5 m zone ('[E] Open cargo') → E → panel both columns → click
    `button[aria-label="move all iron"]` → INVENTORY 'empty', CARGO HOLD 10/40 u. Screenshots
    `.ralph/screenshots/TASK-39-1.png` (in-ship hold-only) / `TASK-39-2.png` (loaded on foot)
    — verified by eye, both correct. Screenshots are NOT git-tracked (only .gitkeep).
  - Stale-test fixes: `repo.test.ts` migration count 4→5 (000004), `schemas.test.ts` CASES
    gained cargo_open / cargo_transfer / cargo (the "covers every registered message type"
    lint test).
  - `.ralph/STRUCTURE.md` updated (state/cargo.ts, ui/cargo-panel.tsx, 000004 migration,
    shared/cargo.ts, interaction.ts + main.tsx + shard.ts line notes).
  - eslint + prettier clean on all touched files; `tsc --noEmit` clean (17:21).

## Working tree

Clean except the untracked `.ralph/handoff/` dir (this file). Everything else is committed in
`212b434`. No background processes are running.

## Next steps

Bookkeeping only, in order (well under one iteration):
1. Full suite: `cd app && npm run test` (~3 min). Expect: the two previously-red tests
   (repo.test migrations, schemas.test coverage) are now green. NOTE: one run this iteration
   showed "3 failed test files" before the fixes; after the fixes both known failures pass in
   isolation (104/104 in those two files). If a THIRD failure appears, it is likely flaky —
   re-run that file alone twice and judge.
2. `cd app && npx tsc --noEmit` (was clean).
3. In `.ralph/tasks/TASK-39.json`: set all 4 step `"pass"` flags to true.
4. In `.ralph/tasks.json`: TASK-39 `"passes": true`.
5. `.ralph/logs/LOG.md`: new entry at the top (date 2026-10-02, summary: shared cargo math +
   persistence + shard/WS/e2e tests + the warp-cargo adopt fix + screenshot paths
   TASK-39-1/2), bump 'Tasks Completed' 52 → 53, 'Current Task' stays —.
6. Delete `.ralph/handoff/TASK-39.md`.
7. Commit (Conventional Commit, e.g. `chore(cargo): TASK-39 close-out — full suite green,
   flags, log`), then output `<promise>TASK-39:DONE</promise>`.

## Dead ends

- No true dead ends. Two near-misses worth knowing:
  - The warp round trip test WOULD have failed on the pre-fix router (stale-row adopt) — the
    fix is in `212b434`; do not "fix" the test by adding flush waits instead.
  - The e2e turn scan (hold 'd' while polling '#interact-prompt' for '[E] Enter ship', then
    's' to walk into the 3–5 m band) passed first try; if it ever flakes, the character spawn
    is 2.5 m to the ship's world-right with identity facing (characterSpawnPos, shared/physics/
    character.ts), so a fixed 'a'/'d' direction + burst turns is the deterministic fallback.
- Do NOT re-run `npx playwright test cargo.spec.ts` without `--config
  playwright.e2e.config.ts` (plain playwright finds no tests).

## How to verify

- `cd app && npx vitest run src/shared/cargo.test.ts src/server/shard/shard.cargo.test.ts
  src/server/shard/persist.test.ts src/server/galaxy/cargo.ws.test.ts src/shared/protocol/
  schemas.test.ts src/server/db/repo.test.ts` — all green in ~10 s.
- `cd app && npx playwright test --config playwright.e2e.config.ts cargo.spec.ts` — green in
  ~25 s (boots its own dev harness; no pre-started server needed).
- Full `npm run test` + `tsc --noEmit` per Next steps.
- AC checklist: capacity per class (shared tests, asserted 40/20/120), transfer validation
  ladder (shard + WS), persistence survives restart (persist round trip) + warp keeps cargo
  (WS warp round trip), selling-from-hold is TASK-40 (out of scope), in-ship HUD button
  (e2e screenshot 1), on-foot prompt + panel (e2e screenshot 2).
