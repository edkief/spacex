# TASK-45 — Rogue AI ship placement (seeded, per-system roster)

## Status
Zero implementation code written. The entire iteration went into a verified codebase survey; this handoff
is the survey. All design decisions below are made — the next session should implement directly.

## Done
- **Committed `fa37bf5`** — the pending, fully-verified TASK-44 close-out that a prior interrupted session
  left uncommitted (targeting tests, e2e, audit manifest, flags, LOG 61, handoff deleted). Not new work;
  just don't be surprised that TASK-44 now passes.
- Full survey for TASK-45 (all file:line verified via an explore pass, paths relative to `app/`).

## Working tree
- Clean except `opencode.json` (local model-provider config — leave uncommitted, NOT task work).
- Nothing of TASK-45 exists yet: **no `src/shared/world/ai.ts`, no `src/shared/ai/` dir, no pirate names list.**
- Build state: TASK-44's LOG claims full `npm run test` green (134 files / 1197 passed / 1 skipped) at
  `fa37bf5`; I did not re-run the full suite.

## Next steps
Implement in this order. All facts verified this session.

### 1. `src/shared/ai/names.ts` (new dir)
40 pirate callsigns. **Each must match `/^[A-Za-z0-9-]{3,16}$/`** (`src/shared/callsign.ts` L4 — no
underscores/spaces; e.g. `BLACKJACK-7`, `RUSTWOLF`, `IRON-MOTH-3`). Export `PIRATE_CALLSIGNS: readonly string[]`
+ a dev-time assertion or unit test that every name passes the pattern and there are exactly 40 uniques.

### 2. `src/shared/world/ai.ts` — roster derivation (pure, client+server identical)
Follow `src/shared/world/deposits.ts` verbatim as the template: module `Map` cache keyed
`` `${galaxySeed}\u0000${systemId}` `` + exported `__resetRosterCache()` test hook (deposits.ts L184–187;
deposits.test.ts L28–41 shows the cold-cache determinism test).

- `export function rosterFor(galaxySeed: string, system: Pick<SystemGen,'systemId'|'planets'>): RogueRosterEntry[]`
  — NOTE: codebase convention is `(galaxySeed, system)` (`padsForSystem` pads.ts L80, `depositsFor` L198,
  `homeDockPosition(galaxySeed, systemId)` dock.ts L19), even though the task text writes `rosterFor(systemId)`.
  Rng seed: `new Rng(hash2(hash2(seedFromString(galaxySeed), seedFromString(systemId)), seedFromString('rogues')))`
  — same sub-seed scheme as deposits.ts L152–156/L210–214. RNG API (`src/shared/random.ts`): `Rng` L66,
  `nextInt(n)` L125, `nextRange(min,max)` L116, `nextF64` L111, `pick` L131.
- Count: `6 + rng.nextInt(5)` → 6–10.
- Class weights: `r<0.50` scout, `r<0.85` interceptor, else freighter. `ShipClassId = 'scout'|'freighter'|'interceptor'`
  (`src/shared/galaxy/types.ts` L41, `src/shared/ships.ts` L20; stats via `shipStats(classId)` ships.ts L159:
  scout hull 100/sh 50, interceptor 80/40, freighter 200/80).
- Names: no-duplicate pick within roster (pick-and-swap over a copied index array, all from the one roster rng).
- **Geometry**: star is at ORIGIN (spawn.ts L12–14 comment: "the in-system star always sits at the origin").
  Planets are anchored at `planetAnchor(i) = {x:(i+1)*10_000, z:0}` (`src/shared/galaxy/planets.ts` L39–41);
  atmosphere radius `planetAtmosphereRadius(planet)` = 1000 or 0 (planets.ts L47, ATMOSPHERE_BOUNDARY_M).
  Stations: the sim has NO orbital station entity — the nearest "station" anchors are the surface settlement
  **pads** (`padsForSystem(galaxySeed, system)` pads.ts L80, `PadInfo.pos`) and `homeDockPosition` (±100 of
  origin, dock.ts L19). Define `MIN_STATION_DIST_U = 200` and reject against BOTH pads and the home dock —
  document the mapping in the file header.
- SpawnPos: seeded angle, radius `rng.nextRange(500, 3000)`, y=0 plane; **rejection loop (bounded, e.g. 64
  tries then fallback accept-last or shrink — keep deterministic!)** rejecting: (a) inside any planet's
  atmosphere sphere (dist2D to anchor ≤ atmRadius), (b) within 200 u of any station anchor, (c) distance
  outside [500,3000]. With planets at ≥10 000 u and 1 km atmospheres, (a) is auto-satisfied for r ≤ 3000 —
  the test must still assert it ("placement test" AC).
- patrolCenter: spawnPos + seeded offset (e.g. 100–400 u, seeded angle); patrolRadius `rng.nextRange(200,800)`.
- Entry type: `{aiId, classId, callsign, spawnPos: Vec3, patrolCenter: Vec3, patrolRadius}`.
  `aiId` = `` `ai:${systemId}:${seq}` `` (stable, mirrors `depositId` scheme deposits.ts L54). Entity id on the
  wire: use the roster `aiId` directly (dev dummy already uses prefix `ai:` shard.ts L1488).

### 3. Shard integration — `src/server/shard/shard.ts` (class `SystemShard` L220)
- Constructor already spawns static rosters: copy the deposits/terminals loop at **L301–309**
  (`spawnDepositEntity` static shape L1685–1707). Add `this.spawnRosterShips()` there using
  `rosterFor(this.galaxySeed, this.system)`.
- Entity shape: `SimEntity` (`src/server/shard/types.ts` L62–226) — kind union **already includes
  `'ai-ship'`** L76–85; `playerId: string|null` "null for AI ships" L87; `ttl?` L110. Build with full
  hull/shields from `shipStats(classId)`, `docked=false`, regime `'space'`, vel 0, pos=spawnPos,
  callsign, `energy` 100 like `entityFromShipRow` (L3080–3132 — copy its field normalization).
- `addEntity(entity)` L594 doc literally says "the AI placement in TASK-45 ... uses it directly".
- **Respawn: NO setTimeout in shard** — all timing is tick-based or `now()`-based (injectable
  `now?: () => number` option L202). Keep `Map<aiId, {roster, respawnAtMs?}>`; in `destroyEntity` L1239–1285
  (called from `applyHit` L653–690; destroyed entity is KEPT frozen, wreck `wreck:<id>` spawned) — for
  kind `'ai-ship'` set `respawnAtMs = now() + 120_000`. In `tick()` L1332–1463 (ttl sweep L1338–1341 is the
  pattern), after the sweep check `now >= respawnAtMs` → reset the SAME entity in place
  (destroyed=false, hull/shields full, pos=spawnPos, vel 0) + debug log `'rogue respawn'` via the injected
  log stub. Re-lock/cleanup: nothing needed (targeting auto-releases; TASK-44 `tickTargetLocks`).
- **Reap = nothing to do**: `galaxy/router.ts` `reapEmpty()` L426–457 drops the whole shard object; AI ships
  are never persisted — `shard/persist.ts` L147–149 already skips them with a TASK-45/46 comment. Add the
  documented comment ("rogues are renewable, reset to full on reap") where the roster spawns.
- Dev dummy `spawnDummyTargetForTesting` shard.ts L1484–1509 already spawns a `kind:'ai-ship'` reusing
  `devDepositSeq` (L1488) and callsign `AI-001-${seq}` — fine to leave; handoff gotcha said rename counters
  only if needed.

### 4. Protocol — `src/shared/protocol/schemas.ts`
- `entityStateSchema` L77–161 is **`.strict()`** — add `ai: z.boolean().optional()` (or literal true) or every
  snapshot with the flag throws. `ENTITY_KINDS` L17–27 already has `'ai-ship'`.
- `entityToState(e, targetedBy?)` shard.ts L3299–3352 — set `ai: true` for kind `'ai-ship'` only (omit else).
- `damageSourceSchema` already supports `{kind:'ai'}` L218–222. Presence entries (`presenceEntrySchema`
  L208–215) stay player-only — AI come through the ENTITY list (spec step 3).
- TASK-67 audit: `tests/abuse/audit.spec.ts` mirrors protocol by hand — snapshot schema changes may need a
  mirror update there (TASK-44 fallout precedent).

### 5. Client
- **Ships do NOT render yet** — `RemoteEntityLayer.RENDERABLE_KINDS = new Set(['character','groundItem'])`
  (`src/client/world/remote-entities.ts` L50, comment L170–171 "ships render in their own later task"). The
  dummy ai-ship is invisible and nobody has complained. So "client renders them identically" = they flow
  through the same pipeline (`main.tsx` `feedRemote` L500–505 already feeds ai-ship into aim-assist L675–696;
  targeting `LOCKABLE` already has 'ai-ship'). **Do NOT build a ship renderer here**; give each ai-ship entity
  a seeded pirate livery in the roster (`{hull,accent,trim}` — `Livery` ships.ts L26, `buildShipMesh`/
  `applyLivery` ship-mesh.ts L51/L111 for shape reference) so the future ship layer + lock-on work unchanged.
- Presence UI: `src/client/hud/player-list.tsx` L13 (self + `store.otherPlayers`) — add an AI section fed from
  entities with `ai:true`: pattern is `PresenceStore.applyActiveEntities` (`src/client/net/presence.ts` L119,
  called with snapshot/entity batches). Show callsign + small 'AI' tag. Full HUD polish is TASK-50.

### 6. Tests (name them exactly like these — copy harness!)
- `src/shared/world/ai.test.ts` (template `src/shared/world/deposits.test.ts`): determinism 3 systems (cache-
  cold via `__resetRosterCache()`), count bounds 6–10, class weights over ~100 seeded systems (generous
  bounds, e.g. scout share 0.35–0.65), station spacing ≥200, no-atmosphere, names unique + pass
  `CALLSIGN_PATTERN`.
- `src/server/shard/shard.ai.test.ts` (template `src/server/shard/shard.targeting.test.ts` — the NEWEST
  harness): `let fakeNow` L37, `makeShard()` L39–57 (stub repo/bus/log + `now: () => fakeNow`),
  `advance(shard, ms)` L60–66 (`fakeNow += 50; shard.sim.step(fakeNow)`), `shipAt` L69–95, `warmup` L381–383.
  Cases: spawn loads 6–10 ai-ship entities with full hull; kill one (`applyHit` hull→0) → NOT respawned at
  119.9 s, respawned full at 120 s; respawn debug log emitted; new shard (reap sim) → roster full again.
- Vitest globs already cover `src/**/*.test.ts` (vitest.config.ts L20–26). vitest testTimeout is 15 s.
- e2e (UI-touching): `tests/e2e/targeting.spec.ts` is the freshest template (claim → `POST /api/dev/dummy-target`
  with localStorage token → assert presence list AI section shows `AI-001…` + 'AI' tag → screenshot
  `.ralph/screenshots/TASK-45-1.png` → console clean). Run e2e config: `playwright.e2e.config.ts`.

### 7. Gates & close-out
`npx tsc --noEmit`; `npm run test` (expect ~135 files); eslint + prettier on touched files; then flags: 4×
`pass:true` in `.ralph/tasks/TASK-45.json`, `passes:true` TASK-45 in `.ralph/tasks.json`, LOG.md entry on top
+ Tasks Completed 61→62, STRUCTURE.md: add `shared/world/ai.ts` + `shared/ai/names.ts` (new dir — must be
listed), delete this handoff, commit, `<promise>TASK-45:DONE</promise>`.

## Dead ends
- First `npm run dev` failed: ports 3000/3001 held by a 1 h 38 m stale dev server from an earlier iteration
  (pids 574638/45/46). Killed; ports free now. If it recurs: `ss -tlnp | grep -E ':(3000|3001)'` then kill.
- zsh: `grep --include=*.ts` unquoted → "no matches found" (glob expands); quote it or cd deeper.
- The old per-planet `AiRoster` stub in `src/shared/galaxy/types.ts` L41–49 (count 2..5, drawn in
  generatePlanet L89–92, asserted system.test.ts L57–61, golden fixture
  `src/shared/galaxy/__fixtures__/system-dev-seed-star0.json`) is TASK-4's flavour data — DO NOT repurpose or
  change it (fixture golden-hash would break). `rosterFor` is a NEW system-level thing next to it.
- No mulberry32-style float RNG: use `Rng` class + `hash2`/`seedFromString` (src/shared/random.ts) only.

## How to verify
```bash
cd /home/ekieffer/Dev/spacex/app
npm run test                                    # full unit suite (green baseline claimed at fa37bf5)
npx tsc --noEmit
npx vitest run src/shared/world/ai.test.ts src/server/shard/shard.ai.test.ts   # new specs
npm run dev                                     # background; :3000 web, :3001 api (kill stale procs first)
npx playwright test -c playwright.e2e.config.ts targeting   # template for the new ai e2e
curl -s localhost:3000/api/health                # {"ok":true,"galaxySeed":"DRIFT-SEED-0001"}
```
