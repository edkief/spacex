# TASK-47 handoff — PvP parity: identical combat pipeline vs players

## Status
Steps 1 and 2 (parity property test + code-path audit, and the live-ws PvP kill
scenario) are DONE, green, and committed. Step 3 (kill feed) is HALF done: the
store (`app/src/client/state/kill-feed.ts`) is written but NOT committed, NOT
wired, and has no component or tests yet. Step 4 (e2e) not started.

## Done
- **Step 1 — `app/src/server/shard/shard.pvp-parity.test.ts`** (5 tests, green, ~4 s):
  - Code-path audit: static source scan of `shard.ts`/`combat.ts`/`shards.ts`
    asserting exactly one `fireLaser`/`fireMissile`/`applyHit`/`handleWeaponContact`
    definition each, `this.fireLaser(` == 2 and `this.fireMissile(` == 2 (both
    `resolveFireIntent` and `resolveAiFire` funnel in — checked via a
    `between(fromSig, toSig)` source slice), one `applyDamage(` call site, and
    `.handleFire(` in exactly one non-test server file (the `routeGameMessage`
    'fire' branch).
  - Parity property test: 100 seeded random fire sequences (mulberry32 from
    `./ai`, weapon/gapTicks/targetPos) replayed on two identical shards —
    interceptor shooter `p1` vs a `scout` target that is `kind:'ai-ship'` in
    one shard and a player ship in the other (same class/start). Tick-by-tick
    hull/shield trajectories compared with `toEqual` (EXACT). Plus a
    determinism re-run of sequence 0 on fresh shards. In-shard (no WS):
    fake `now` + `shard.sim.step(fakeNow)` per 50 ms, `addEntity` +
    `registerConnection`, `spawnRogues: false`, open-space positions (no LOS).
- **Step 2 — `app/src/server/shard/shard.pvp.ws.test.ts`** (1 test, green, ~14 s):
  Real ws clients A/B/C over `routeGameMessage` (production dispatcher). A
  (classId mutated to `interceptor`, nose +x via `quatFromEuler(π/2,0,0)`)
  parks 60 m from B (scout) and 60 m off from C in the 60 km space anchor;
  A `target_lock`s B, 7 lasers (350 ms apart) drain shields 50→0 and open the
  hull for 6, 4 missiles (2.6 s apart) kill B. Asserts: kill event
  `{killer: A, victim: B, weapon: 'missile'}` on C AND B, C's full ledger
  (10 hits with exact structural fields + `toBeCloseTo(x, 9)` on
  shieldHit/hullHit, 1 destroyed, 1 kill, 7 laser-fired, 4 missile-fired,
  4 missile-impact), wreck `killerId` in shard state AND on the 10 Hz
  snapshot wire, self-fire denial (no 'hit' events), and friendly fire
  (A's laser hits C — no team immunity).
- **Step 3 (partial) — `app/src/client/state/kill-feed.ts`** (UNCOMMITTED, complete):
  subscribe/emit store per the repo idiom — `KILL_FEED_MAX = 5`,
  `KILL_FEED_TTL_MS = 10_000`, `indexKillFeedEntities(entities)` (id +
  playerId → callsign/kind maps, no emit), `pushKillEvent(killerPlayerId,
  victimShipId, weapon, now)` (prunes expired, caps last 5, resolves
  callsigns, `pvp = victim.kind !== 'ai-ship'`), `removeKillFeedEntry(id)`,
  `killFeedEntries()`, `killFeedSubscribe(fn)`, `__resetKillFeed()`.
  Not yet imported anywhere; does not compile into the app yet but `tsc` was
  green at the last commit and the file is self-contained.

## Working tree
- Committed: `35d577c` (step 1), `4fb861c` (step 2). Both green, lint/prettier/tsc clean.
- Uncommitted: `app/src/client/state/kill-feed.ts` (new file, the only TASK-47
  change). Commit it together with the step-3 work (or now, to be safe).
- Pre-existing unrelated dirty files: modified screenshot PNGs under
  `.ralph/screenshots/` (from earlier tasks) and `.ralph/split/TASK-46/` —
  leave both alone; do NOT add them to your commit.
- `npx tsc --noEmit` green; `npx vitest run` green at commit time (104+ files).

## Next steps
1. **Component** `app/src/client/hud/kill-feed.tsx` (mirror `hud/toast-stack.tsx`
   patterns): `<div id="kill-feed">` top-CENTER (`position: absolute; top: 1rem;
   left: 50%; transform: translateX(-50%)`), flex column, `pointerEvents: 'none'`,
   `aria-live="polite"`, monospace. Entry text exactly `killer ▸ weapon ▸ victim`;
   color white (`#ffffff`) when `entry.pvp` else grey (`#8b97ab`). Per-entry
   `setTimeout(KILL_FEED_TTL_MS)` → `removeKillFeedEntry(id)` (schedule once per
   entry id; clear all on unmount). Optional CSS keyframes fading the last 2 s.
2. **Wire in `app/src/client/main.tsx`**:
   - import `indexKillFeedEntities, pushKillEvent` from `./state/kill-feed` and
     `KillFeed` from `./hud/kill-feed`.
   - In `feedRemote` (~line 500, called for entity_update batches AND
     snapshots): add `indexKillFeedEntities(entities);`.
   - In the `onCombatEvent` callback (~line 727, the one calling
     `recordCombatEvent(event)`): add
     `if (event.kind === 'kill') pushKillEvent(event.killer, event.victim, event.weapon, Date.now());`
   - Mount `<KillFeed />` in the App render next to `<ToastStack store={store} />`
     (~line 1187).
3. **State unit test** `app/src/client/state/kill-feed.test.ts` (node env; follow
   `credit-float.test.ts` / `docked.test.ts`): immediate catch-up emit,
   emit-only-on-change, cap of 5 (6 kills → oldest dropped), TTL pruning on
   push (entry at t, push at t+10_001 → pruned), name resolution (index an
   entity with `playerId`+`callsign` → killer resolves; victim by `id`),
   `pvp` false for `kind: 'ai-ship'` victim / true for ship / true for
   unindexed, `removeKillFeedEntry` no-op for unknown id, `__resetKillFeed`.
4. **Step 4 — e2e** `tests/e2e/pvp-kill.spec.ts` (follow
   `tests/e2e/weapons.spec.ts`: the `e2eServer` fixture boots the dev server
   itself — never alongside `npm run dev`; `test.setTimeout(150_000)`;
   `collectErrors` + `assertClean`; `ClaimPage.claim(uniqueCallsign('pvp'))`):
   two contexts A + B. Both claim. A teleports both to the space anchor via
   `POST /api/dev/teleport` (Bearer token, body `{x, y, z}` — check the exact
   schema in `src/server/routes/dev.ts`; A → `{x:60000,y:60000,z:0}`,
   B → `{x:60060,y:60000,z:0}`), wait ~1 s for the space regime. Both are
   scouts (laser only): A LMB-clicks the canvas ~25 times at ~350 ms spacing
   (aim assist auto-targets the nearest ship ≤ 800 m — B; scout needs 19 laser
   hits: 50 shields + 100 hull at 8/shot, 3/s server rate). On BOTH pages wait
   for `#kill-feed` to contain B's callsign (pvp → white entry), screenshot to
   `.ralph/screenshots/TASK-47-1.png`, assertClean, close contexts.
5. Run `npx eslint --fix` + `npx prettier --write` on touched files, `npx tsc
   --noEmit`, `npm run test` (full suite ~2 min), then the e2e spec (check
   `package.json` for the e2e script / `playwright.e2e.config.ts`).
6. Bookkeeping: set `passes: true` for TASK-47 in `.ralph/tasks.json` + the 4
   step `pass` flags in `.ralph/tasks/TASK-47.json`, add the LOG.md entry
   (newest on top, with screenshot path), commit (Conventional Commit), output
   the promise.

## Dead ends
- **Exact float equality on damage splits FAILS**: the sim keeps NORMALIZED
  hull/shields; after 6 laser shots `(1 − 48/50) * 50` = 2.0000000000000018,
  so the 7th shot's `shieldHit`/`hullHit` and subsequent missile splits carry
  ~1e-15 error. Use `toBeCloseTo(x, 9)` for numeric splits; structural fields
  (kind/target/source/weapon/damage) stay exact.
- **`WsTestClient.next()` SPLICEs** the matched message out of
  `client.messages` — cannot be used for non-destructive ledger assertions.
  Wait with a polling predicate over `client.messages.some(...)` instead.
- **Self-directed fire with `targetId = own shipId`** is silently ignored by
  the targetId path in `fireLaser` (which requires `targetId !== entity.id`)
  and falls through to the FORWARD RAYCAST — it hits whatever is dead ahead.
  The self-fire denial test only works AFTER the ahead-target is destroyed,
  and must assert absence of 'hit'/'destroyed' events (the 'laser-fired' FX
  IS still broadcast for an accepted fire with no resolved target).
- **Method-body extraction**: a multi-line method signature ends with
  `  ): void {` (exactly two-space indent), so "next line indented by exactly
  two spaces" cuts the body off. The audit test uses
  `between(src, 'private resolveFireIntent(', 'private fireLaser(')` style
  signature-to-signature slices instead.
- Do NOT use a 60 m target offset in +x for C while A's nose faces +x with a
  live B in front: the raycast fallback would hit B instead of C. C sits on +y.

## How to verify
- `cd app && npx vitest run src/server/shard/shard.pvp-parity.test.ts src/server/shard/shard.pvp.ws.test.ts`
  → 6 tests green (~18 s total).
- After step 3: `npx vitest run src/client/state/kill-feed.test.ts` +
  `npx tsc --noEmit` + `npx eslint src/client/state/kill-feed.ts src/client/hud/kill-feed.tsx src/client/main.tsx src/client/state/kill-feed.test.ts`.
- Full suite: `npm run test` (≈ 2 min, was 104 files / 898 passed before this task).
- After step 4: the pvp-kill e2e spec (dev server is booted by the fixture —
  make sure no other `npm run dev` is holding the port) + confirm the
  screenshot shows the top-center feed with a white `A ▸ laser ▸ B` entry.
