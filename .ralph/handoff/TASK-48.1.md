# TASK-48.1 handoff — Server: fix drone hover height, get shard hazard suite green

## Status
The core fix is DONE and committed (1002185): drones now hover above the LOCAL ground at their orbit point, the shard hazard suite is 4/4 green in ~3 s, and the per-tick hover cost is bounded by a persistent per-planet height sampler. What remains is closing the 5 PRE-EXISTING full-suite reds that TASK-48's WIP commits (267103f/4574163) left behind (3 already fixed in the working tree, 2 not started), one final full `npm run test` + lint pass, and the close-out bookkeeping.

## Done
- **Committed 1002185** `fix(shard): drone patrol hovers above local ground (TASK-48.1)`:
  - `app/src/server/shard/shard.ts`: `stepDrones()` patrol branch hovers at local ground at the orbit point (was `drone.cell.y + DRONE_HOVER_M` — cell-CENTER ground, ~90 m below a hilly orbit → 80 m aggro radius unreachable, the documented `expected 0 to be greater than or equal to 2` failure). The drone record (`readonly drones` map, ~line 345) gained `planetId`; `spawnDroneEntity` sets it from `hazard.planetId`; new `heightSamplers` field + `localHeightAt(planet)` helper (~line 3690) lazily build/cache ONE persistent height sampler per planet; `Planet` type imported from `@shared/galaxy/types`.
  - `app/src/shared/world/deposits.ts`: new export `planetHeightSampler(seed, planet)` — the SAME pure field as `planetHeightAt` but with a PERSISTENT cell/lattice memo (per-call `planetField` builds a fresh cache every call).
  - `app/src/server/shard/shard.hazards.test.ts`: the final pool assertion (`50 - 3*hits`) ignored the committed 5/s regen (a drones cell drains nothing → the player is 'outside' → regen applies; observed end-state 50 after 8 hits). It now REPLAYS the committed pure math per tick (regen FIRST then hits — `stepHazardExposure` at ~line 1695 precedes `stepDrones` at ~line 1749 — exact in quarter units, incl. the shield-burn window) over the captured hit timestamps; also asserts `damage === 3` on every hit frame (the AC).
- **Fixed in the working tree (NOT yet committed, NOT yet re-run)** — three of the pre-existing reds, each verified against its exact failure message:
  - `app/tests/abuse/audit.spec.ts`: added `'hazard'` to `OUTBOUND_ONLY` (failure: `registry types that are neither inbound nor server-only: ['hazard']`).
  - `app/src/shared/protocol/schemas.test.ts`: added `hazard` to the `CASES` table (valid `{exposure: 42.5, inside: 'storm', recoveringUntil: ...}` / invalid `{exposure: 51}` — schema: exposure 0..50, inside enum storm|radzone, both optional-ish; failure: CASES 32 keys vs 33 registered).
  - `app/src/server/shard/shard.pvp-parity.test.ts`: `expect(count(src, 'applyDamage(')).toBe(1)` → `toBe(3)` with a comment (the TASK-48 call sites are `droneFire` and `damageDroneForTesting` — both use the shared model by design; failure: `expected 3 to be 1`).

## Working tree
- HEAD = 1002185 (core fix committed). Uncommitted: the 3 test files listed above — each a one-to-three-line edit against a verified failure, but re-run them before trusting.
- Do NOT commit the pre-existing dirty files: many modified `.ralph/screenshots/*.png` and untracked `.ralph/split/TASK-46/` (per the TASK-48.1 spec note).
- All temp debug files (`src/tmp-bench.test.ts`, `bench-out.txt`, `tick-profile.txt`) were created and DELETED; `shard.ts` is clean of instrumentation.
- Builds: `npx tsc --noEmit` green; shard.hazards 4/4 (~3 s); shared hazards 19/19; shard.damage 9/9 (~5 s).

## Next steps
1. Two remaining pre-existing reds (both verified failing in TWO consecutive full runs — not flakes):
   - `app/src/server/shard/shard.character.test.ts:208-211` ('docked ship: character spawns 2.5 m...'): snapshot kind list now includes the seeded drones — failure `expected ['character','drone','drone',…(4)] to deeply equal ['character','ship']`. Fix: add `&& s.kind !== 'drone'` to the `.filter(...)` at line 210 (exact precedent: 'deposit'/'terminal'/'ai-ship' in the same filter + comment at 204-207).
   - `app/src/server/shard/shard.test.ts:~259` ('broadcasts entity_update exactly 10 Hz: once every 2nd tick, shared buffer'): `expect(new Set(sends).size).toBe(1)` now gets 10 — drones' orbit positions change EVERY tick, so the serialized shared buffer is no longer byte-identical between 10 Hz frames. NOT investigated: read the test first; likely options are comparing buffers with drone entities excluded, or asserting equality only on the non-drone portion. (The 10 Hz cadence part of the test still passes — only the byte-identity assert.)
   - `app/src/server/galaxy/router.ws.test.ts` — 2 failures, NOT investigated: line ~186 ('10 clients joining 3 systems in parallel get distinct, correct shard state') and ~247 ('join into a full (16-player) system returns system-full'). Most likely exact shard-state/entity-count asserts that now include drones (same family). Run the file, read the diff, fix the asserts to the drone precedent.
2. Re-run: the 3 already-fixed files + the 2-3 newly fixed files (`npx vitest run <files>`).
3. `npx eslint --fix` + `npx prettier --write` on every file touched in this task (shard.ts, deposits.ts, shard.hazards.test.ts are already lint-clean; the audit/schemas/pvp-parity/character/shard/router test files are not).
4. Full `cd app && npm run test` (~2 min) → must be green (144 files, ~1286 tests; was 8 failed / 1277 passed before the 5 fixes). `npx tsc --noEmit` again.
5. Close-out: set `passes: true` for TASK-48.1 in `.ralph/tasks.json` (~line 508) + both step `pass: true` in `.ralph/tasks/TASK-48.1.json`; LOG.md entry at top (date 2026-10-03, summary, no screenshots — server task) + bump 'Tasks Completed' 64 → 65; commit conventional (mention TASK-48.1); output the promise. (Parent TASK-48 close-out belongs to TASK-48.4 — do it there.)

## Dead ends
- **Per-call `planetHeightAt` in the tick (the spec's literal suggestion): too slow at scale.** Micro-benched at 0.028 µs/call, but inside the shard it cost ~30 µs × drone × tick (each call rebuilds the noise channels — `seedFromString`×2 + `makeNoiseChannel`×2 — plus a FRESH cell Map, so every call is 4 cache-miss fbm01 evals with BigInt hashing). 39 drones → 1.29 ms/tick (HEAD baseline 0.12) → the 600 s wreck-ttl test (12 000 fake-timer ticks) timed out at 15 s. The bench under-measured (JIT warm state). Fix = persistent per-planet `planetHeightSampler` (0.18 ms/tick; the orbit re-samples the same cells → memo hits). The micro-bench was also misleading because a warm loop over ONE planet is far cheaper than 39 drones across many planets.
- The TASK-48 handoff's original dead end still holds: `this.resolveRegimeCtx(entity).options.heightAt(x,z)` re-primes the shared per-planet TerrainContext cache (evict + regenerate 3×3 chunk neighborhood) on every call from every entity at a different position → hundreds of ms/tick → the suite crawls.
- Setting `entity.planetId = hazard.planetId` in `spawnDroneEntity` (spec option A) was deliberately NOT used: `entity.planetId` rides the wire entity encoding and feeds LOS/terrain code paths; storing `planetId` on the drone record (spec option B) has zero side effects.
- The old line-293 assertion (`exposure === 50 - 3*hits`) CANNOT pass against committed behavior — 5/s regen applies in a drones cell (it drains nothing), so the pool regens between hits. Behavior is committed (do not change it); the assertion was the bug (same class as the 2 test bugs fixed in 4574163).

## How to verify
- `cd app && npx vitest run src/server/shard/shard.hazards.test.ts` → **4/4 in a few seconds** (if it crawls for minutes you are in the TerrainContext dead end).
- `cd app && npx vitest run src/shared/world/hazards.test.ts` → 19/19.
- `cd app && npx vitest run src/server/shard/shard.damage.test.ts` → 9/9 in ~5 s (times out at 15 s if the hover cost regressed — this is the tick-cost guard).
- `cd app && npx tsc --noEmit` → clean.
- `cd app && npm run test` → green once the 5 pre-existing reds above are fixed (~1286 tests, ~2 min).
- eslint + prettier clean on all touched files.
