# TASK-95 handoff — Full touch loop e2e (SC-1 by touch) + controls docs

## Status

The spec now has a real LAND approach (not a drop): `landOnPad()` teleports 300 m out / 150 m up (atmosphere confirmed green), then runs a `close → glide → vtol → roll` state machine driven by touch channels. The ONLY red is `facePad()`: after the teleport the ship NEVER rotates — the aim error stays ~constant (last sample `yaw=0.953 pitch=0.303`) and the HUD shows `Speed 0`, i.e. the touch yaw/pitch channels produce no server-side rotation. Legs 1–5 (claim, mobile profile, touch menu/warp, thrust, yaw-in-space) + the atmosphere assertion are green; legs 6–10 (land/exit/mine/re-enter/sell) and the docs half are untested/unstarted.

## Done

- **Wire-field bug found + fixed (this iteration's main find):** the wire carries TWO regime fields — `regime` = 'docked' | 'sublight' (the ship STATE, `entityToState` shard.ts:4254) and `flightRegime` = 'space' | 'atmosphere' | 'surface' (shard.ts:4258). The spec's `tapShipUpdates` was reading only `regime`, so the `atmosphere` poll could NEVER pass (it received 'sublight'). `Tap` now carries both; `landOnPad` polls `flightRegime === 'atmosphere'`. This fix verified working — run 4 got past it.
- **`app/tests/e2e/touch-loop.spec.ts` land leg rewritten:**
  - `aimAt(page, pad)` — inlined TASK-80 probe math: decomposes the fwd→pad rotation axis onto the ship's local up (signed yaw error, physics convention: + = nose LEFT) and local right (signed pitch error, negated: physics +pitch = nose DOWN).
  - `facePad(page, pad, budgetMs=8000)` — cruise.spec.ts `faceAnchor` pattern extended to pitch: one axis per pass, press `|err|/TURN_RATE − 0.2 s` (release lag), settle 300 ms, re-measure. Sign flip applied (touch yaw +1 = physics −yaw; touch pitch +1 = physics −pitch). **This is where it dies (see Next steps).**
  - `landOnPad(page, baseURL, token, pad, padId)` — teleports `{pad.x+300, pad.y+150, pad.z}`, polls `flightRegime === 'atmosphere'`, then the phase machine (each pass reads the SERVER tap `lastState`): `close` (facePad + thrust 1 s → glide at ≤ 100 m), `glide` (thrust 0, momentum + drag + gravity; VTOL at ≤ 25 m & alt < 8 m; roll if grounded early), `vtol` (vtol:1 — server assist damps drift, 1.35·g lift brakes descent; roll if it climbs > 30 m), `roll` (facePad + vtol:1 + thrust:1 skim for 1.2 s — the dock condition has NO horizontal-speed cap, so a slow surface crossing inside the 20 m disc docks; re-enters vtol when close+low). 90 s wall budget, returns `{vtolHeldAtDock, landMs}` for the log.
  - Test timeout bumped `test.setTimeout(360_000)`; console log now prints `land=… s (vtol-held-at-dock=…)`.
- Prior iteration (already committed in `162bdec`): egress wiring fix in `app/src/client/main.tsx` (docked `exit_ship` branch moved into shared `interactPressRef.current` — touch disembark), claim→menu→warp→space legs of the spec.

## Working tree

- `app/tests/e2e/touch-loop.spec.ts` — MODIFIED this iteration (land-approach rewrite + flightRegime tap fix), tsc GREEN (`npx tsc --noEmit` clean), NOT committed.
- `app/src/client/main.tsx` — MODIFIED prior iteration (egress wiring), committed in `162bdec`.
- Docs (task step 2) NOT started — README lines 17/38 + `app/docs/` note (see Next steps 3).
- Pre-existing dirty files (screenshots, `.ralph/decisions.jsonl`, `PRD.md`, `.gitignore`, `ralph.config.json`, `app/.ralph/`, `app/.trace-tmp/`, untracked TASK-89..92 specs) are NOT this task's — exclude from the commit, per convention.
- Build: `npx tsc --noEmit` GREEN.

## Next steps

1. **Fix `facePad` — the ship does not rotate after the land-leg teleport.** Diagnosis: aim error ~constant + HUD `Speed 0` ⇒ the touch yaw/pitch channel produces no server-side rotation (thrust+yaw both worked earlier IN SPACE, so the touch→server path itself works; the difference is the post-teleport state / atmosphere). Debug in order:
   a. Add `rot` to the `Tap` in `tapShipUpdates` (entity_update carries `rot` — shard.ts `entityToState` line 4249, omitted when identity) so you can observe SERVER-side rotation directly; the client probe only sees it after the 10 Hz snapshot blend (~100–300 ms), which can mask a working rotation if the settle window is too short.
   b. In `facePad`, after each `setChannel` log `page.evaluate(() => (window.__TOUCH__ as any).channels)` — confirm the channel is actually held in the source, and log server rot delta per pass.
   c. If the server rot genuinely never changes: bisect with a yaw burst in SPACE (before the teleport, where run 2 proved it worked) vs. after the teleport in atmosphere; check the client flight loop gate (`wireDockedIndicator()` main.tsx:1841 — must be false; `effectiveFlightPressed` chartOpen — must be closed) and `enqueueInput` drops (stale seq / `sim.inputDrops`).
   d. If it works but the signs are wrong, flip the `-Math.sign(aim[axis])` map in `facePad`.
   e. If headless steering proves too flaky, FALLBACK (touch-only, no steering): teleport to the EXACT unit-test start point `{pad.x + 100, pad.y + 50, pad.z}` (shard.pads.approach.test.ts — proven to dock in 4.5 s with 90 u/s inbound), then a `thrust:1` burst (any direction that closes on the pad — check the bearing once with `aimAt` and accept |yaw err| < ~0.5), `vtol:1` within 25 m / < 8 m, settle → docked. The server assist (×0.5/tick, < 50 u/s, < 100 m) does the parking.
2. **Run:** `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line` (foreground; ~3–6 min). Legs 5–10 have NEVER executed — expect first-touch issues there (walkUntilPrompt is verbatim from the green touch-onfoot spec; the egress legs need the main.tsx fix, which is committed).
3. **Docs (step 2, not started):** README.md line 17 "no touch controls" + line 38 "Keyboard-only play" → update; short 'Touch controls' note under Controls (dual-stick: left = thrust+yaw, right = pitch+roll, + FIRE/VTOL/BOOST/TARGET/weapon; on-foot: move stick + RUN/JUMP/DROP/INTERACT; MENU button; Settings → Controls Auto/On/Off). Dev note in `app/docs/contributing.md` (or architecture.md): VIRTUAL-KEY design (touch → same key names, `mergePressed` union; server/prediction/wire/cheat-resistance unchanged — `src/client/input/touch.ts`, main.tsx `effectivePressed()`) + enablement (auto = maxTouchPoints > 0, persisted on `Settings.touchControls`).
4. **Full gate:** `cd app && npx tsc --noEmit`; FULL `npm run test` (unit — re-run known wall-clock/WS load flakes in isolation); `npm run test:e2e` (full suite, no keyboard regression); `eslint --fix` + `prettier --write` on `app/src/client/main.tsx`, `app/tests/e2e/touch-loop.spec.ts`, `README.md`, touched doc file.
5. **Bookkeeping:** both steps `pass: true` in `.ralph/tasks/TASK-95.json`; `passes: true` for TASK-95 in `.ralph/tasks.json` (~line 849); LOG.md entry at top with the `[TASK-95] loop wall=…` value; delete this handoff in the completing commit; `feat(TASK-95): full touch loop + docs`.

## Dead ends

- **60 m straight drop onto the pad (original spec):** the ship free-falls into the 20 m pad disc and the pad machine docks it instantly → the atmosphere poll received `docked` (run 1) / `sublight` (run 3). Fixed by the approach + the flightRegime field fix.
- **Run 4: `facePad` timed out at 8 s — `never faced the pad (yaw=0.953, pitch=0.303)`; no rotation observed (HUD Speed 0).** Cause not yet isolated (see Next steps 1a–1d). The aim math signs have been derived twice and check out (touch yaw +1 → 'd' → readSchemeInput flip → physics yaw −1 = nose RIGHT; matches the passing space-yaw leg); the rotation axis decomposition (axis·up = yaw, −axis·right = pitch) is standard. Prime suspects: (a) the tap/probe can't see the server rot, so a working rotation looks like none — add rot to the Tap FIRST; (b) input frames dropped post-teleport (stale seq, `sim.inputDrops`); (c) client predictor not reconciling the teleported pose.

## How to verify

- `cd app && npx tsc --noEmit` — green at handoff.
- `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line` — expected: legs 1–5 + atmosphere green, `facePad` red (as of handoff).
- Server physics reference: `app/src/server/shard/shard.pads.approach.test.ts` (the proven 100 m/50 m → docked-in-4.5 s approach script), `app/src/shared/world/pads.ts` (dock condition: surface, |vel.y| < 2, ≤ 20 m, ≤ 1 m alt; NO horizontal-speed cap; VTOL assist ×0.5/tick < 50 u/s within 100 m), `app/src/shared/regime.ts` (atmosphere enter = 1000 m band around the planet anchor).
- Wire fields: `app/src/server/shard/shard.ts` `entityToState` (~line 4239) — `regime` (docked/sublight) vs `flightRegime` (space/atmosphere/surface) vs `padId`.
