# Handoff: TASK-87

## Status

The airless-planet pass-through (regime stuck in `space`, ship flying through the planet) is **fully fixed at the shared source** and unit-verified (new drop-off test fails pre-fix AND without gravity); the e2e spec is **green end-to-end for the atmospheric path** (43.6 s), and the **airless path passed all physics + terrain assertions in a live run** — only the final canvas check changed after that run, so one more airless e2e pass is the main remaining proof, plus the full e2e set, final `fix(TASK-87):` commit, and close-out.

## Done

**Previous iterations (already committed `b345c9d` + `0d667a3`):** root cause (airless planets: `atmosphereRadius 0` → regime machine never left `space`, no ground collision in space); fix: `surfaceDiscAt()` in `shared/galaxy/planets.ts` (2 km solid disc of a landable airless planet), `regimeFor` resolves `space → surface` directly for landable airless inside disc + low + slow, `integrateShip` ground-clamps `space` ships in the disc + `SURFACE_FRICTION`, `shard.ts` `resolveRegimeCtx` + `prediction.ts` `optionsAt` both wire the same disc; contract tests in `shared/planet-approach.test.ts` + `shared/regime.test.ts`; e2e `tests/e2e/planet-approach.spec.ts`.

**This iteration (iteration 7) — uncommitted:**

1. **Root-caused the live airless e2e failure** (run 1: regime stayed `space`, ship ended x=7984 past the 2 km disc, minY=0). Two stacked physics bugs the flat-terrain unit tests couldn't see (real terrain undulates, e.g. system `d30ed9b5336c1a28` planet 0: heights 146→193→180→244→304→204 over x=12600→8000):
   - **No gravity in the disc**: the ground clamp only pushes UP, so a ship clamped onto a ridge keeps its height over the next dip, leaves ground contact, loses friction, and skims the whole disc at full approach speed.
   - **Friction too weak under thrust**: the e2e holds W the entire approach; with `SURFACE_FRICTION=1.0` and scout acceleration 40, velocity asymptotes to a/f = 40 u/s — never reaching the ≤5 u/s `SURFACE_SPEED_LIMIT_M_S` threshold, so the ship grinds out of the disc without resolving `surface`.

2. **Fix in `app/src/shared/physics/flight.ts` `integrateStep`:**
   - `inDisc` computed once from `s.pos` (before motion; the ≤2 u substep can't change a 2 km verdict); `vel.y -= GRAVITY * h` applied in the `space` branch when inDisc (a ship in the disc is physically on that planet); ground handling reuses the same `inDisc`.
   - `SURFACE_FRICTION` 1.0 → **10.0** — must exceed acceleration/SURFACE_SPEED_LIMIT (40/5 = 8) so a W-holding ship asymptotes below 5 u/s and lands. Documented v1 hard grind-stop (120 u/s stops in ~15 m, ~100 g); atmospheric bodies keep drag as their stop (friction only applies `planet === undefined`).
   - Doc comments updated on the constant + ground block (header stays accurate).

3. **New unit test** in `app/src/shared/planet-approach.test.ts`: "a drop-off-terrain approach still lands (gravity re-settles the ship)" — ridge at the disc edge (x=12000, h=300) dropping to ~100 by x=11700, then gentle bumps. **Verified red** (a) against pre-fix `flight.ts` (`git stash push -- src/shared/physics/flight.ts`) and (b) with the gravity line removed at f=10 (gravity is the load-bearing piece; f=10 alone is not enough). Also fixed altitude measurement to count only INSIDE the disc ("inside the body" = inside the disc; outside it the y=0 start legitimately sits below decorative terrain). `planet-approach.test.ts` now 9/9; + `regime.test.ts` = 30/30.

4. **E2E hardened** (`app/tests/e2e/planet-approach.spec.ts`):
   - Claim loop: up to 4 cheap REST-only player claims, keeps the first whose home system has a landable **airless** planet (~55% of the 200 seeded systems do — scanned: airless-only=13, both=97, atmo-only=84; home system derives from the player UUID). Tap filter / callsign / localStorage now use the chosen session (`s`).
   - Lower-band canvas check: replaced the 32×32 **variance > 1** (copied from terrain-live) with `canvasRegionStats` mean luminance ≥ 60 over DOM band y∈[0.6,1], polled up to 5 s — the ship can land on a FLAT biome (uniform grey ground reads variance 0, which is exactly what flaked runs 2/3); grey terrain ≈ 120–160 vs starfield ≈ 20–40.

5. **E2E runs this iteration** (`npx playwright test --config playwright.e2e.config.ts tests/e2e/planet-approach.spec.ts`):
   - Run 2 (physics fixed, **airless** home `ba7323191035bf20`, planet 2 @ x=30000): `flightRegime=space -> surface`, minDist=1958.9 (inside the 2000 disc), minY=0, terrain mounted — **all physics assertions passed**; only the then-old variance check read 0 (flat grey biome) → motivated the mean check. Screenshot (viewed): green biome + grey ground + horizon curve, SURFACE tag, SPD 0.0.
   - Run 3: identical, failed only on a stale `lower` log variable → fixed.
   - **Run 4: PASSED 43.6 s** (atmospheric home `3066e1f69b71b215`): `space -> atmosphere -> surface`, minDist=826.7, chunks=34, groundMean=66.3, screenshot saved to `.ralph/screenshots/TASK-87-1.png` (viewed: ship on terrain, biomes below, starfield above the horizon, SURFACE tag).

6. **At handoff:** `npx tsc --noEmit` green; eslint --fix clean; prettier applied (it reflowed `regime.ts` / `regime.test.ts` — formatting only, tests green); no background processes.

## Working tree

- **Committed (mine, from earlier iterations):** `b345c9d` (root cause + contract test + e2e repro), `0d667a3` (disc fix + friction + server/client wiring + e2e + old handoff).
- **Uncommitted (mine, this iteration):** `app/src/shared/physics/flight.ts` (disc gravity + friction 10), `app/src/shared/planet-approach.test.ts` (drop-off test), `app/tests/e2e/planet-approach.spec.ts` (claim loop + mean check), `app/src/shared/regime.ts` + `app/src/shared/regime.test.ts` (prettier-only reflows), `.ralph/screenshots/TASK-87-1.png` (untracked, from the passing run), this handoff.
- **Pre-existing dirty (NOT mine — do NOT commit):** `.gitignore`, `.ralph/decisions.jsonl`, `ralph.config.json`, all `.ralph/screenshots/*.png` mods, untracked `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `.ralph/tasks/TASK-87.json`, `.ralph/tasks/TASK-88.json`, `app/.ralph/`.
- **Builds:** tsc green; unit suites green (full suite was 1757 passed / 1 skipped earlier this session, BEFORE the friction change — re-run needed, see next steps).

## Next steps

In order:
1. `cd app && npm run test` (~2.5 min) — confirm full suite green after the friction change (expect 1758 passed / 1 skipped; `transitionCycle` p99 delta is the documented wall-clock load flake — green in isolation).
2. Re-run `npx playwright test --config playwright.e2e.config.ts tests/e2e/planet-approach.spec.ts` until a run hits an **airless** home system (~55% per run) and passes end-to-end including the new mean check (airless physics + terrain mount already proven in run 2; only the canvas check changed since). Check the log line `airless=true` and `groundMean=...`.
3. Run the spec's required e2e set (single worker, config `playwright.e2e.config.ts`): planet-approach, atmosphere, atmosphere-view, terrain-live, deep-space, cruise, flight.
4. Final commit `fix(TASK-87): ...` (stage only the mine files above + handoff deletion + close-out files; wip commits from earlier iterations may stay in history — the board's other tasks landed across wip+fix commits too).
5. Close out: `.ralph/tasks/TASK-87.json` all 4 steps `pass: true`; `.ralph/tasks.json` TASK-87 `passes: true`; `.ralph/logs/LOG.md` entry at top (date, summary, screenshot path `.ralph/screenshots/TASK-87-1.png`) + bump "Tasks Completed" 102 → 103; delete `.ralph/handoff/TASK-87.md`; output `<promise>TASK-87:DONE</promise>`.

No question for a human — everything is decided.

## Dead ends

- **Variance > 1 canvas check is unusable for "terrain on screen"** when the ship lands on a flat biome (uniform grey ground → variance exactly 0). Mean luminance over the lower band is the robust ground-vs-starfield discriminator.
- **Flat-terrain unit tests (`heightAt: () => 0`) cannot catch terrain-contact bugs** — the one-way-up clamp bug only shows on undulating terrain. The drop-off shape (high ridge at disc entry, low ground inside) is the minimal repro.
- **Gravity alone is not the fix** at the original f=1: thrust asymptote a/f = 40 u/s > the 5 u/s surface threshold, so a W-holding ship never qualifies. Both disc-gravity AND f=10 are load-bearing (each verified red when removed).
- **A single random player claim lands in a non-airless home ~45% of the time** (home system derives from the player UUID) — the claim loop is the cheap fix; no dev route exists to pick a system.

## How to verify

Follow the task spec (`.ralph/tasks/TASK-87.json`): unit contract in `src/shared/planet-approach.test.ts` (must fail pre-fix, pass post-fix), `npx tsc --noEmit`, full `npm run test`, e2e list in step 4 above, screenshot `.ralph/screenshots/TASK-87-1.png` must show terrain under the ship (not a starfield hole), client/server regime agreement via the shared `surfaceDiscAt` wiring in `shard.ts`/`prediction.ts` (AC 4).
