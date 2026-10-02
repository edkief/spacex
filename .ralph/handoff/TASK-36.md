# TASK-36 handoff — On-foot multiplayer: character sync

Status at handoff (2026-10-02 09:00 UTC): steps 1–3 IMPLEMENTED and `tsc --noEmit` clean; committed.
Step 4 (tests: unit / WS / e2e / scale) + lint pass + bookkeeping are LEFT. Working tree clean.

## What landed (steps 1–3)

1. **`src/client/world/character-mesh.ts`** (NEW) — `buildCharacterMesh` + color defaults extracted out of WorldManager (same capsule for local AND remote players; kills the import cycle).
2. **`src/client/world/remote-entities.ts`** (NEW) — `RemoteEntityLayer`:
   - feeds TASK-14's `RemoteEntityTracker` (200 ms buffer) from every 10 Hz batch, self excluded by callsign;
   - renders `kind 'character'` (same capsule, livery-tinted, dedup guard, stale/dimmed opacity) and `kind 'groundItem'` (`buildGroundItemMesh` — icosahedron chunk + additive halo, `GROUND_ITEM_COLORS` per resource);
   - callsign labels: screen-space DOM, per-frame OUTSIDE React (`applyLabels`), ≤ 16 (nearest first), `labelOpacity(dist)` full ≤ 4 m → 0 at 10 m, `data-callsign` attr for e2e; meshes register with `entity-registry` (frame monitor);
   - `clear()` on system swap; `dispose()` removes the `#remote-labels` host; `labelStates(now)` exposed for tests.
3. **`WorldManager.ts`** — owns the layer: `feedRemoteEntities(entities, selfCallsign)`, `attachRemoteLabels(host)`, `projectToScreen(pos)` (camera + canvas size, null when behind camera); rAF drives `remoteLayer.renderFrame(now)` pre-render; `swapWorld` re-parents + clears; re-exports the character-mesh module (transitionCycle keeps importing from WorldManager).
4. **`interpolation.ts`** — `RemoteEntityTracker.reset()`.
5. **`presence.ts`** — `applyActiveEntities(entities)` derives `onFoot` per player (a `character` entity matched by playerId, fallback callsign ⇒ on foot); emits ONLY when a flag flips. `setSelfOnFoot(bool)` for the self row. Wire protocol UNCHANGED (spec: derived from the entity list).
6. **`player-list.tsx`** — status dot → `RegimeIcon` (inline SVG: walking figure `data-mode="foot"` amber vs ship `data-mode="ship"` green).
7. **`main.tsx`** — `feedRemote(entities)` closure wired into BOTH `onWorldEntities` (10 Hz) and `onSnapshotEntities` (ground truth); self onFoot fed from the self-entity bridge (on-foot branch true / else false); `#remote-labels` overlay div inserted as canvas sibling when the world is created (removed on dispose).

## Left to do (step 4 + close-out), in order

1. **Unit tests** (node env — no DOM; three math is fine; `resetEntityRegistry()` in beforeEach):
   - NEW `src/client/world/remote-entities.test.ts`: `labelOpacity` (4→1, 7→0.5, 10→0); `buildGroundItemMesh` colors; addSnapshot self-exclusion (ship AND character by callsign); interpolated placement — feed snapshots at t=100 pos(0,0,0) + t=300 pos(2,0,0), `renderFrame(490)` → x≈1.9 (200 ms behind), registry 'character'; livery tint (hull→body, accent→head); removal (second snapshot w/o id → mesh gone, unregistered); ground item mesh + color; label cap: fake projector `{x:0,y:0,dist:3}`, 20 characters → 16 visible / 4 not; behind-camera (projector null) → not visible.
   - ADD to `src/client/net/presence.test.ts` (exists): `applyActiveEntities` sets/clears onFoot via character entity (playerId + callsign fallback), unchanged list → NO emit; `setSelfOnFoot`.
   - NEW `src/client/hud/player-list.test.tsx` (renderToStaticMarkup pattern, real PresenceStore): foot row `data-mode="foot"`, ship row `data-mode="ship"`, self row present.
2. **WS test** NEW `src/server/galaxy/multiplayer-foot.ws.test.ts` (copy the inventory.ws.test.ts scaffold; SYSTEM_INSTANCE_COUNT 8; claims unique):
   - A+B on foot (same pad spot), C in ship near pad: A sends `'input' {seq:1, thrust:1, ...}` (server holds the frame — one send suffices), after 1 s B's last wire pos of char A within 2 m of `shard.entities.get(charA.id).ship.pos`;
   - ground-item round trip: A drops 1 iron (give first), BOTH see it, B `interact pickup` (same spot ⇒ in range), both see removal + B's inventory {iron:1} (picker's, not dropper's);
   - presence data: A on foot, B in ship → A sees B ship entity + NO char; B `exit_ship` → A sees char onFoot:true; B `enter_ship` → char gone;
   - scale: 4 on foot + 4 in ship (near pad, atmosphere), `shard.histogram.reset()` + 1.5 s idle → baseline p95; reset + 4× input thrust walk 5 s → p95; assert delta ≤ 4 ms + all 4 moved.
3. **E2E** NEW `tests/e2e/multiplayer-foot.spec.ts`: extract `RawWsClient` into `tests/e2e/raw-ws.ts` (copy from disembark.spec.ts lines 34–90); server-side dock BOTH players (claim → pad-target → raw WS join/warp/teleport/docked → close); two browser contexts `?sys=padSystem` (localStorage session), each presses E; assert each page sees `#remote-labels [data-callsign="<other>"]` visible + `#player-list [data-mode="foot"]` count 2 (self + peer); screenshots `.ralph/screenshots/TASK-36-1.png` (A sees B) / `TASK-36-2.png` (B sees A); `assertClean` both. `test.setTimeout(120_000)`.
4. Verify: `npm run test` (suite green — watch presence.integration.test.ts: applySnapshot entries now carry onFoot undefined, sameSet still fine), `npx playwright test --config playwright.e2e.config.ts tests/e2e/multiplayer-foot.spec.ts`, eslint --fix + prettier --write on touched files, tsc.
5. Bookkeeping: step pass flags (all 4) in `.ralph/tasks/TASK-36.json`, `passes: true` in tasks.json, LOG.md entry (newest top, bump Tasks Completed 49 → 50), update STRUCTURE.md only if dirs changed (they didn't — all files in existing dirs), delete this handoff, Conventional Commit, promise.

## Notes / gotchas

- Characters of two players docked at the SAME pad spot spawn at the SAME offset → ~0.5 m apart: label visible (~4.5 m from camera, opacity 1) and B's pickup of A's drop is trivially in the 3 m range.
- `RemoteEntityTracker.addSnapshot` DROPS ids absent from the call — every call must carry the FULL entity list (snapshots do).
- Self exclusion is by CALLSIGN (covers the frozen docked ship that still carries it after disembark), not by id.
- Projector uses the camera matrix from the PREVIOUS render frame (renderFrame runs pre-render in rAF) — 1-frame lag, visually negligible.
- The spec's "frame monitor p95 within baseline + 4 ms" is proxied by the SERVER tick histogram (`shard.histogram.percentile(0.95)`) per the task's step 4 note (client headless can't run 8 tabs).
- Dev server (`npm run dev` in `app/`) was NOT running at handoff — start it for the e2e/Playwright pass (e2e fixtures boot their own server though).
- No unrelated tests were touched; if the full suite shows a break, it is in the presence feed path (check emit-on-change only).
