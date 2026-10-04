# TASK-49 handoff — ship destruction → dock respawn → wreck impostor

## Status

Server-side (steps 1–2) DONE + unit-tested; all 12 stale tests fixed; FULL unit suite green (1340 passed / 1 skipped); `tsc --noEmit` clean. Client FX step 3 is HALF DONE: explosion FX + slow-mo land (`c7b9d1e`) but the 'SHIP LOST' overlay, the wreck impostor render + killer marker, and main.tsx wiring are NOT started. E2E (step 4) NOT started. Two commits this iteration: `fd598a8` (12 stale tests) + `c7b9d1e` (explosion FX).

## Done (committed)

### Server (steps 1–2, prior session, commit b52fcc5)
- `combat.ts`: `ResolveHitCode += 'docked'`; `resolveHit` early-returns `{ok:false,code:'docked'}` for docked targets (the single gate for every fire path). `applyHit` deliberately has NO docked gate (a direct second `applyHit` on the respawned ship deals damage — by design).
- `shard.ts`: `destroyEntity` → `respawnPlayer(entity.playerId)` for player ships; `respawnPlayer` resets the SAME wire-stable entity in place (classId 'scout', hull/shields 1, starter livery, docked, pos = nearest pad 3D or `homeDockPosition(seed, systemId)`, regime surface/space, cargo LOST, inventory+credits KEPT, destroyed scrubbed, energy full, idle from conns); `persistRespawn` fire-and-forget tx. Docked gates: lockableShip, AI laser candidates, fire raycast, validMissileTarget, AI players list.
- `repo.ts`: `respawnShip` (one UPDATE: scout caps, docked, caller pos/rot/regime/onPad, cargo '{}', destroyed_at null).
- `shard.destruction-respawn.test.ts` (6/6): full loop, persist, docked invulnerability via handleFire + handleTargetLock, wreck 600 s ttl, third-observer sees wreck+killerId on snapshot.

### 12 stale tests fixed (commit fd598a8)
- `shard.damage.test.ts` (6 reworked, 9/9): added `respawnPos(system, from)` helper mirroring respawnPlayer (padsForSystem nearest 3D / homeDockPosition); killing-hit test asserts docked scout respawn + wreck at death spot; snapshot test expects scout@respawn + wreck@death with killerId; double-destroy → renamed, second direct `applyHit` now returns a damage object on the FRESH scout (wrecks/unknown still undefined, exactly one 'destroyed'); "stops integrating" → respawned scout live again (enqueueInput true, first input = take-off), wreck frozen 20 ticks; ttl test → respawned scout waits docked; bus-swap test → updates in place (respawn already ran).
- `shard.combat.test.ts` (2): dead-target test → killed ship respawns docked (`code:'docked'`), wreck still `dead-target`; pipeline test final fire → 'docked' + wreck 'dead-target' assert added.
- `shard.combat.ws.test.ts` (1): after teleports, `eA.docked=false; eB.docked=false` (teleported = in flight; safe-zone gate would refuse everything); post-kill asserts docked scout + wreck; final fire → 'docked' + wreck 'dead-target'.
- `shard.weapons.ws.test.ts` (2): `parkInSpace` clears `docked` on both teleported ships.
- `shard.pvp.ws.test.ts` (1): after teleports, clear `docked` on all three; step (6) asserts respawned docked scout.
- `shard.destruction-respawn.test.ts`: `shard.playerEntities` (private) → `shard.entities.get('ship-p2')` (tsc).

### Client FX (commit c7b9d1e, step 3 PARTIAL)
- `world/combat-fx.ts`: `addExplosion(point)` — 1 s core flash (expanding additive sphere) + expanding camera-facing shockwave quad (RingGeometry, billboards to `boundCamera` from the attach closure) + 8 tumbling tetrahedrons (3 s fade, deterministic per-index dir/spin) + `armSlowMo()`; SLOW_MO_MS 1000 / SLOW_MO_SCALE 0.3. VIRTUAL fx clock: `frame(nowMs)` advances `fxTime += dt * timeScale`; all flash `born` values are fxTime-based (laser/impact switched too) — slow-mo stretches effect aging only, shake + prediction stay real-time.
- `fx.ts`: `FxWorld += addExplosion`; `playCombatFx` 'destroyed' → `addExplosion(pos)` + `screenShake(6)` ('hit' keeps addImpactFlash).
- `fx.test.ts`: mock updated; 2 new tests (destroyed→explosion+shake at known pos; unresolvable→nothing).

## Working tree
Clean (beyond the pre-existing `.ralph/screenshots/*.png` noise — do NOT commit/revert those). Baseline: `c7b9d1e`.

## Verification state
- `npx vitest run --exclude 'tests/e2e/**' --exclude 'tests/abuse/**'` → 148 files, 1340 passed / 1 skipped (run at 12:12, before the FX commit).
- `npx tsc --noEmit` → clean (after FX commit).
- eslint --fix + prettier --write run on the 3 FX files (clean).
- Rerun full unit suite + tsc at next-iteration start (fast, ~2 min) before close-out.

## Remaining work (in order)

### Step 3 remainder (client, all under `app/src/client`)
1. **`state/kill-feed.ts`**: export `callsignForPlayer(playerId): string | undefined` (wraps the private `byPlayer` map — already fed from presence in main.tsx:655-664, self included).
2. **`state/ship-lost.ts` (NEW)**: store `ShipLostMoment { callsign, killer, at }`, `SHIP_LOST_MS = 2000`, `showShipLost(m)`, `hideShipLost()`, `shipLostCurrent()`, `shipLostSubscribe(fn)` — the subscribe/emit idiom of the other `state/*.ts` (see kill-feed.ts as template).
3. **`ui/ship-lost-overlay.tsx` (NEW)**: `<div id="ship-lost" role="alert">` full-screen overlay (warp-overlay.tsx is the styling template): "SHIP LOST" + the callsign + "Killed by <killer>" + "Respawning at nearest dock". `useEffect` timer hides after SHIP_LOST_MS; unmounts when null.
4. **`main.tsx`**: in the combat_event handler (~line 878-903), after `ingestCombatEvent`: `if (event.kind === 'destroyed' && event.target === selfShipIdRef.current) showShipLost({ callsign: store.selfPlayer?.callsign ?? 'your ship', killer: callsignForPlayer(event.source.id) ?? event.source.id, at: Date.now() })` (only OUR ship shows the moment; AI killer → raw id). Render `<ShipLostOverlay />` next to `<WarpOverlay />` (~line 1483).
5. **`world/remote-entities.ts`** (wreck impostor + killer marker): add `'wreck'` to `RENDERABLE_KINDS`; `RemoteInfo += killerId?`; new `wrecks` Map + `renderWreck(id, info, state, now)`: frozen `createShipRender(info.classId ?? 'scout', false, info.livery)` in a Group + additive fire-glow sphere (opacity flicker `0.25 + 0.15*sin(now*0.01)`), transform from interpolated state, `registerEntity(id, 'wreck')`, dispose on `drop()` (add wrecks to `drop` + `renderedIds`). Killer marker label: extend `LabelState` with `text?: string` (+ `opacityFor?: (dist)=>number`); in `labelStates` add a wreck candidate when `info.kind==='wreck'` (no callsign needed): text `▸ ${callsignForPlayer(info.killerId) ?? info.killerId ?? 'wreck'}`, opacity = dist ≤ 200 ? 1 : 0 (spec: visible within 200 m); in `applyLabels` use `s.text ?? s.callsign` for textContent. WRECK marker constants: `WRECK_KILLER_MARK_M = 200`.
6. **Tests**: `state/ship-lost.test.ts` (show/subscribe/hide, template: kill-feed.test.ts). Optionally extend `world/remote-entities.test.ts` (wreck rendered + killer marker label state ≤200 m). Rerun `npx vitest run` full + `tsc --noEmit` + eslint/prettier.

### Step 4 (e2e)
7. **Extend `tests/e2e/pvp-kill.spec.ts`** (all plumbing exists: ClaimPage, raw claim, `warpShip`, dev-teleport `/api/dev/teleport`, 22×LMB at 350 ms = 19-hit kill). Add a second test: same setup; after the kill — (a) B's page `#ship-lost` visible + contains the killer callsign → screenshot `.ralph/screenshots/TASK-49-1.png` (the moment); (b) A's page: `#remote-labels div` with text `▸ <aCallsign>` visible (wreck 60 m away < 200 m) → screenshot `TASK-49-2.png`; (c) `#ship-lost` hidden after ~2 s, B's ship is the docked respawned scout (docked indicator on B's page) → screenshot `TASK-49-3.png`. `test.setTimeout(150_000)`; `collectErrors` both pages. Run: `npm run test:e2e` (playwright.e2e.config.ts; the e2eServer fixture boots its own server — never alongside npm run dev). The existing TASK-47 test in that file must stay green.

### Close-out
8. Set the 4 step `pass: true` + `passes: true` for TASK-49 in `.ralph/tasks/TASK-49.json` AND `.ralph/tasks.json`; add `.ralph/logs/LOG.md` entry at top (date, summary, screenshot paths); check `.ralph/STRUCTURE.md` (new client files: state/ship-lost.ts, ui/ship-lost-overlay.tsx — exclude dotfiles/tests/config; probably no STRUCTURE change since those dirs exist); DELETE this handoff; commit (Conventional Commit); output `<promise>TASK-49:DONE</promise>`.

## Dead ends / notes
- Ad-hoc probe via `npx tsx` in /tmp/opencode failed earlier (heredoc Permission denied, module resolution) — probe via scratch vitest under `app/src/` if needed.
- Do NOT add a docked gate to `applyHit` — resolveHit-only is the design; the double-destroy test encodes it.
- `teleportForTesting` does NOT clear `docked` — ws/e2e tests that teleport ships into space must clear the flag or the safe-zone gate refuses every engagement (the one line each ws test now carries). In the e2e, the BROWSER clients take off via real input only if needed — check whether the aim-assist fire path (pvp-kill) worked before: it did pre-TASK-49 because pre-TASK-49 docked ships were targetable; POST-TASK-49 the pvp-kill e2e may itself need the teleported ships undocked (e.g. via a dev endpoint or an input frame) — verify the EXISTING TASK-47 e2e still passes first and fix it the same way if it breaks.
- Wreck wire entity has NO callsign (only classId/livery/killerId/ttl) — label it via killerId only.
- CombatFx camera: `boundCamera` captured once in the constructor (WorldManager camera is created once, scene-level fx group survives swapWorld) — no reattach needed.
