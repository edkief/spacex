# TASK-55 handoff — Settings: quality presets, sensitivity, reduced motion, persistence

## Status
Implementation of ALL 4 spec steps is complete and committed as a wip commit; ~90% of unit tests written and green. Remaining: the e2e spec (step 4), the UI screenshot, eslint/prettier pass, and the close-out bookkeeping (tasks.json / LOG.md / STRUCTURE.md / promise).

## Done
**Step 1 — Settings model + presets:**
- `app/src/shared/settings.ts` (rewritten): `QualityPreset` type, `PRESETS` table (high 8192/2048 tris + 8 km + 2500 stars + fx 1.0 / medium 2048/512 + 6 km + 1250 + 0.6 / low 512/128 + 4 km + 500 + 0.3, all `shadowless: true`), `lodRadiiFor(preset)` (high = 512/2048/8000 EXACTLY the pipeline's original constants — default behavior bit-identical; medium 512/1536/6000; low 384/1024/4000), `Settings` type = `{quality, sensitivity, 'reduced-motion'}`, `DEFAULT_SETTINGS`, `clampSensitivity` (0.5–2.0), `normalizeSettings` (handles the raw JSON **string** column AND parsed objects — see Dead ends), `scaleLookDemand` (scales ONLY yaw/pitch/roll, clamps to [-1,1]), `SettingsUpdateSchema` (zod, strict, partial) + `applySettingsUpdate` (clamps sensitivity, merges partials).
- `app/src/client/world/chunks.ts`: `liveLod` mutable ref + `setLodRadii()` / `lodRadii()` (the SettingsBridge); `lodRingForDistance` now reads the live ref. `keepBuiltLod()` (exported) keeps a FULL build's LOD when a preset change re-classifies it to far — **applied to the ACTIVE SET loop in `mountable()` ONLY; the horizon loop deliberately still mounts full builds outside the active window as the cheap far quad** (the first draft applied it to the horizon loop too and broke the streaming-benchmark triangle budget — see Dead ends; that is fixed in the committed state).
- `app/src/client/fx.ts`: `fxQuality` multiplier gates every FX spawn via `Math.random() >= fxSpawnRate()` (read live off the store; `fxSpawnRate()` exported).
- `app/src/client/a11y/reduced-motion.ts` (the client settings store, rewritten): added `setQuality` (also re-points `setLodRadii`), `setSensitivity` (clamped), `applySettings` (boot restore; re-tunes the pipeline through the same live path). `__resetSettings` also resets the radii.
- `app/src/client/world/WorldManager.ts`: starfield count read from the active preset's `starCount` at world build.

**Step 2 — Endpoints + persistence:**
- Migration `app/src/server/db/migrations/000005_player_settings.sql` (`ALTER TABLE players ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`); both drizzle dialects in `schema.ts` gained the `settings` column.
- `repo.ts`: `getPlayerSettings` / `updatePlayerSettings` (JSON string in/out, `normalizeSettings` at the read boundary) — interface + implementation.
- `routes/players.ts`: `GET` + `PUT /api/players/settings` (auth via `requireAuth`; PUT is zod-validated partial — bad preset → 400 `{code:'invalid-settings', errors}`, non-numeric sensitivity/unknown fields → 400, out-of-range sensitivity CLAMPED; returns the new full row).
- `routes/session.ts`: `GET /api/session` response now carries `settings` (defaults for a first join).
- Client boot: `main.tsx` effect fetches `/api/players/settings` on session and calls `applySettings(normalizeSettings(...))` (restored Low re-tunes the LOD radii live). `app/src/client/net/settings-api.ts`: `fetchSettings` / `putSettings` (failure-tolerant wrappers).

**Step 3 — Panel UI:**
- `app/src/client/ui/settings-panel.tsx`: `SettingsPanel` (four sections). IDs: `#settings-panel`, `#settings-quality` section, `#settings-quality-{high|medium|low}` buttons (`aria-pressed`), `#settings-sensitivity` + `#settings-sensitivity-value`, `#settings-sensitivity-slider` (range 0.5–2.0 step 0.1, **debounced 300 ms → 1 PUT**), `#reduced-motion-toggle` (immediate — KEPT the exact id/role/aria the TASK-54 a11y e2e asserts), `#settings-keybinds-heading` + `#settings-keybinds` (static list: WASD+mouse, E, T, 1/2, M, ESC, F3, Enter), `#settings-reset` (ONE PUT with all three defaults). Preset click + toggle persist IMMEDIATELY (no debounce). No token → local apply only, no PUT.
- `esc-menu.tsx`: the stub line + inline toggle replaced by `<SettingsPanel token={props.token}/>`; `EscMenuProps` gained `token: string | null` (main.tsx passes `session.token`).
- Sensitivity wiring: `main.tsx` on-foot loop multiplies the yaw demand by the live sensitivity; ship loop wraps `remapper.readInput(pressed)` in `scaleLookDemand(...)`. `shared/protocol/inputs.ts`: `inputToCharacterInput`'s left/right thresholds are now INCLUSIVE (`<= -0.5` / `>= 0.5`) so the 0.5x preset's full-hold demand (exactly 0.5) still registers — thrust thresholds untouched.

**Step 4 — Tests (unit, all green at commit time):**
- `shared/settings.test.ts` (preset table pinned verbatim, radii, clamp, scaleLookDemand, normalize incl. the JSON-string column, PUT boundary 400/clamp/strict, applySettingsUpdate).
- `client/world/chunks.lod-preset.test.ts` (live re-classification, per-preset boundaries, keepBuiltLod no-pop, impostor unaffected).
- `client/fx.quality.test.ts` (1.0 always plays, 0.3 skip/play by roll, 0.6 boundary).
- `client/ui/settings-panel.test.tsx` (6 tests: sections render, **preset switch re-tunes `lodRadii()`**, **5 drags → 1 PUT** with fake timers + native-value-setter input dispatch, toggle immediate PUT, reset = 1 PUT + pipeline re-tune, no-token sends nothing).
- `server/routes/players.settings.api.test.ts` (defaults, 401, partial merge, bad preset 400, non-numeric 400, clamp, **PUT Low → /api/session restores Low**, first-join defaults).
- `inputs.test.ts` +1 case (0.5x edge), `esc-menu.test.tsx` updated (token prop, settings test now asserts the panel sections; `#esc-menu-settings-stub` is GONE — any other reference to that id will break), `repo.test.ts` migration pin 5 → 6.

## Working tree
ALL work committed as `wip(TASK-55): ...` (this commit). Working tree should be clean after the handoff commit; dev server NOT running (never started — the e2e needs it). Builds: `npx tsc --noEmit` clean at commit time. Full `npm run test`: everything green EXCEPT two failures found in the one full run, BOTH since addressed in the committed tree: (1) `streaming-benchmark.test.ts` triangle budget 418098 > 400000 — root-caused to the horizon loop, FIXED (re-verified: streaming-benchmark + chunks + chunk-scene + repo tests 60/60 green); (2) `repo.test.ts` migration count 6≠5 — FIXED (pin → 6). One `sell.ws.test.ts` failure appeared in that same full run but passed in isolation — the documented load-sensitive flake family (TASK-46/48.4 precedent), almost certainly not related (settings never touches selling); re-run the full suite to confirm.

## Next steps
1. Run the FULL unit suite: `cd app && npm run test` — expect green (173+ files). If `sell.ws.test.ts` or any perf-guard test fails ONLY in the full run, re-run it in isolation (flake family) before touching it.
2. **E2E (the main remaining deliverable):** `npm run dev` (background, `app/` dir) → write `app/tests/e2e/settings.spec.ts`. Pattern: copy the claim/dock/teleport boilerplate from `tests/e2e/hazards.spec.ts` or `on-foot-hud.spec.ts`. Flow: claim → boot → ESC → click `#esc-menu-settings` → click `#settings-quality-low` → `page.waitForFunction(() => window.__STREAM__ && window.__STREAM__.lodRadii().farMaxM === 4000)` (the dev hook was ADDED to `stream-debug.ts` — `__STREAM__.lodRadii()`) → assert `#settings-quality-low` `aria-pressed=true` → screenshot to `.ralph/screenshots/TASK-55-1.png`. Optionally also assert the slider: set the value + fire an input event, wait ~500 ms, and check the server row via `fetch('/api/players/settings', {headers:{authorization:...}})` (or a raw fetch in the spec with the session token). Run `npx playwright test -c playwright.e2e.config.ts settings` (check how other specs are invoked).
3. eslint --fix + prettier --write on all touched files; re-run the touched unit tests.
4. Close-out bookkeeping: set the 4 step `pass: true` in `.ralph/tasks/TASK-55.json`; set `"passes": true` for TASK-55 in `.ralph/tasks.json`; LOG.md entry at top; delete this handoff; commit (Conventional Commit, e.g. `feat(TASK-55): ...`); output `<promise>TASK-55:DONE</promise>`.
5. Kill the dev server before the promise.

## Dead ends
- **`normalizeSettings` expected a parsed object but the column is a JSON STRING** — the API round-trip silently fell back to defaults for every write (the repo read returned the factory defaults even though the DB row contained the new JSON; a raw-SQL select proved the write landed). Fixed by parsing strings at the boundary (parse failure → full defaults).
- **Horizon-loop no-pop rule broke the triangle budget** (`streaming-benchmark.test.ts`: 418098 > 400000): applying `keepBuiltLod` to the OUTSIDE-the-active-window loop mounted full builds at up to 8 km as mid (2048 tris) instead of the far quad (2 tris). Fixed by limiting the no-pop rule to the active set (the AC's "existing chunks" are the ones the player can reach; the horizon quad is by design).
- **First derived `lodRadiiFor` table (500/375/250 near) changed the high preset's radii** away from the pipeline's original 512/2048/8000 constants — the original constants must stay exact so default behavior is bit-identical (the streaming suite is the canary). Replaced with a hand-pinned switch.
- My first `chunks.lod-preset.test.ts` had wrong ring math (assumed 3.5 km was 'mid' under high — the mid ring ends at 2048 m); test fixed, code was right.
- Range-input React onChange in happy-dom: use the native value setter + dispatch `input` (NOT `change`) — the working pattern is in `settings-panel.test.tsx` `drag()`.

## How to verify
- `cd app && npx tsc --noEmit` (clean at commit time).
- `cd app && npm run test` — full suite green (see Working tree caveat on the one flake).
- Touched fast set: `npx vitest run src/shared/settings.test.ts src/client/world/chunks.lod-preset.test.ts src/client/fx.quality.test.ts src/client/fx.test.ts src/client/ui/settings-panel.test.tsx src/client/ui/esc-menu.test.tsx src/shared/protocol/inputs.test.ts src/server/routes/players.settings.api.test.ts src/client/a11y/reduced-motion.test.ts` (73/73 at commit time).
- E2e per Next steps #2; `tests/e2e/aria-coverage.spec.ts` is the canary for the reduced-motion toggle id (it must keep passing — the toggle id/role were preserved inside the new panel).
- The `#esc-menu-settings-stub` id no longer exists (grep for it before deleting any leftover references).
