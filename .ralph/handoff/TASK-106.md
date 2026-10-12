# TASK-106 handoff — VTOL hover: deterministic 10 m altitude-hold + wire tag

## Status

Implementation and ALL task tests are complete and green (unit + protocol + shard sim, run in isolation). The only remaining work is a full-suite re-run under quiet load (3 known wall-clock flake tests failed in the last two full runs — all proven green in isolation, none reference `hover`), plus bookkeeping (tasks.json flag, LOG.md, final `feat(TASK-106)` commit). Nothing is half-finished.

## Done

- **`app/src/shared/physics/hover.ts` (NEW)** — `HOVER_ALT_M = 10`, `HOVER_KP = 2`, `HOVER_KD = 4`, and pure `hoverLift(alt, velY, gravity, vtolLift)` = `clamp(GRAVITY + KP·(target − alt) − KD·velY, 0, VTOL_LIFT)`. Constants + stability proof (roots −2±√2, discrete poles ≈ {0.97, 0.84}) in the module doc. gravity/vtolLift passed in (no import cycle with flight.ts).
- **`app/src/shared/physics/flight.ts`** — `ShipInput` gained `hover?: 0 | 1` (default 0); `integrateShip` normalizes it to 0/1 in the clamped input; the atmosphere/surface branch of `integrateStep` gets a NEW `if (input.hover === 1)` lift that REPLACES the legacy VTOL lift for that substep (the legacy `input.up` branch now also requires `input.hover !== 1` — mutually exclusive, matching the wire rule). The hover lift is applied BEFORE the gravity add and reads the PRE-gravity velocity (see Dead ends for why). Space: no-op (branch unreachable). `integrateShip` re-exports `HOVER_ALT_M, HOVER_KP, HOVER_KD, hoverLift` from ./hover. Header + atmosphere-branch doc comments updated.
- **`app/src/shared/protocol/inputs.ts`** — `inputToShipInput`: `hover` tag → `up: 1` AND `hover: 1` (hover implies up; up = 1 when EITHER 'vtol' or 'hover' present, hover = 1 only when 'hover' present). `shipInputToPayload`: `hover: 1` → 'hover' tag (wins over 'vtol' — redundant since it implies up), else legacy 'vtol' rule unchanged; 'hover+boost' combined form. Doc comments carry the client-side precedence rule (hover toggle → 'hover', legacy held-key → 'vtol').
- **`app/src/client/net/prediction.ts`** — `inputFinite` now includes `(i.hover ?? 0)` (TASK-76.1 no-poison guard, one line).
- **`app/src/shared/physics/flight.test.ts`** — new `describe('hover altitude-hold (TASK-106)')`: hover off byte-identical (both regimes) + hover-on actually differs; space no-op (toStrictEqual); convergence 100 m → 10±2 m in ≤ 400 ticks (20 s) + last-200-ticks max|err| < 2 + |vel.y| < 0.5; slope tracking (heightAt = 0.01·x, 5 u/s, 200 ticks, worst err < 2, x moves > 30); surface re-engage (landed ship lifts > 5 m in 5 s); lift bounded by VTOL_LIFT (max net +0.35·g, exact at airless alt 0); determinism (deep-equal).
- **`app/src/shared/protocol/inputs.test.ts`** — all existing CASES inputs extended with `hover: 0` (round-trip shape is now exact-including-hover), 2 new CASES (hover; hover+boost), new hover-tag tests for both directions, character-mapping leak test for 'hover'.
- **`app/src/server/shard/shard.hover.test.ts` (NEW)** — real-shard sim test (same harness as shard.pads.approach.test.ts: stub repo/bus/log, addEntity + registerConnection, enqueueInput + sim.step per tick): gas-class landable planet, ship teleported 100 m up at PAD+300 m x, 400 ticks of `action: 'hover'` → asserts terrain + 10 m ± 2 m and |vel.y| < 0.5 (measured: alt 10.006 m, |vy| 0.0034, density 0.0899); then 30 ticks without the tag → asserts descent > 1 m. No tick-loop change was needed (server already flows `inputToShipInput(heldInput)` + TerrainContext heightAt into integrateShip — verified in shard.ts:1897-1906).
- `npx tsc --noEmit` GREEN; eslint --fix + prettier --write done on all touched files.

## Working tree

NOT committed (everything is uncommitted in the working tree on `master`):

- NEW: `app/src/shared/physics/hover.ts`, `app/src/server/shard/shard.hover.test.ts`
- MODIFIED: `app/src/shared/physics/flight.ts`, `app/src/shared/physics/flight.test.ts`, `app/src/shared/protocol/inputs.ts`, `app/src/shared/protocol/inputs.test.ts`, `app/src/client/net/prediction.ts`
- Scratch (NOT committed, safe to delete): `.ralph/logs/t106/` (hover-sim prototypes, margin.txt, test logs)

The working tree ALSO contains pre-existing unrelated dirt from earlier iterations (do NOT commit these): `.gitignore`, `.ralph/prd/PRD.md`, `.ralph/tasks.json` (has earlier tasks' edits), `ralph.config.json`, ~100 modified `.ralph/screenshots/*.png`, untracked `.ralph/tasks/TASK-*.json` specs, `.agents/`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `app/.ralph/`, `app/.trace-tmp/`, `.gitattributes`.

Builds: yes — `npx tsc --noEmit` exit 0.

## Next steps

1. Re-run the full suite from `app/`: `npm run test` (~165 s). Expect the 3 wall-clock flake tests to pass under quiet load:
   - `src/client/ui/combat-hud/combat-hud.test.tsx` > "per-frame projection stays under the hud budget" (1.6 ms vs 1 ms microbenchmark — green in isolation)
   - `tests/abuse/abuse.spec.ts` (2 of 8; 50–65 s wall-clock WS rate-limit timing — green 8/8 in isolation at 07:25)
   - `src/server/galaxy/inventory.ws.test.ts` > "A drops, BOTH see the ground item" (live-WS timeout — green in isolation)
   All three have ZERO references to `hover` (grep-verified); they are the documented wall-clock flake family (see LOG.md TASK-95.2 entry). If any fails again in isolation, investigate — but the expected outcome is green.
2. Verify the task tests once more: `npx vitest run src/shared/physics/flight.test.ts src/shared/protocol/inputs.test.ts src/server/shard/shard.hover.test.ts` (last run: 68/68 green).
3. Set `"passes": true` for TASK-106 in `.ralph/tasks.json` (line ~930, id "TASK-106" block — the block at line 926 currently reads `"passes": false`).
4. LOG.md entry at top (date, summary, no screenshot — spec says no client wiring/no e2e); bump 'Tasks Completed' 123 → 124; 'Current Task' line.
5. STRUCTURE.md: check whether `app/src/shared/physics/` is listed with its modules (a new `hover.ts` file was added — no NEW directories, so probably no change needed).
6. Commit (Conventional Commit): `feat(TASK-106): VTOL hover — deterministic 10 m altitude-hold + wire tag` — stage ONLY: the 5 modified app files + 2 new app files + `.ralph/handoff/TASK-106.md` + `.ralph/tasks.json` (after the passes flip) + `.ralph/logs/LOG.md`. Delete this handoff file in the same commit. Then output `<promise>TASK-106:DONE</promise>`.

## Dead ends

- **Hover lift applied AFTER gravity (legacy VTOL ordering) → rest point bias.** First prototype (lift reading the post-gravity velocity) settled at 10.98 m, not 10 m: the −KD·velY term samples velY that already includes −g·h of this step, leaking a dt·KD·g bias (≈1.9 m at dt 0.05 s, ≈0.3 m at dt 1/60 — a systematic client/server prediction offset). Fixed by applying the hover lift BEFORE the gravity add, reading the pre-gravity velocity (rest point is exactly the target at every dt; verified in the hover.ts doc). This is the one ordering asymmetry vs the legacy VTOL path — it is documented in both files.
- **Prototype margin data** (in `.ralph/logs/t106/`): convergence 100 m → band at 9–18 s (density-dependent, all < 20 s), worst band excursion ≈ 2.0 m (under the < 2 m "stays" check which measures the tail only), final |vy| < 0.005; gas-class shard run: alt 10.006 m, |vy| 0.0034 — comfortable margins everywhere.

## How to verify

From `app/`:
1. `npx tsc --noEmit` → exit 0
2. `npx vitest run src/shared/physics/flight.test.ts src/shared/protocol/inputs.test.ts src/server/shard/shard.hover.test.ts` → 68/68 (flight 41, inputs 26 incl. the it.each round-trips, shard.hover 1)
3. `npx vitest run src/client/ui/combat-hud/combat-hud.test.tsx tests/abuse/abuse.spec.ts src/server/galaxy/inventory.ws.test.ts` → green (the 3 flake-prone files, in isolation)
4. `npm run test` → full suite green (1928+ passed; watch only for the 3 flake tests under load)
5. Golden fixtures untouched: `git diff --stat app/src/shared/physics/__fixtures__/` → empty (the byte-identical contract)
