# TASK-42 Handoff — Combat core: hitbox damage pipeline, shield-first

## Status
Implementation is COMPLETE and tested (all acceptance criteria met; full suite green with
one documented flake class). What remains is bookkeeping only: re-verify, flip the flags,
bump the log count, commit, output the promise. The flags were deliberately left `false`
per the handoff instructions of the iteration that built this.

## Done
All in the working tree (uncommitted at handoff time — will be committed as a `wip(TASK-42)` commit):

- `app/src/shared/weapons.ts` (NEW): `WeaponSpec {id, damage, range}` — the contract TASK-43's
  weapons supply (damage in absolute points, range in metres).
- `app/src/server/shard/combat.ts` (NEW): the server-side resolver.
  - `lineOfSight(from, to, heightAt, samples=5)` — pure raycast; subsampled endpoints-included;
    occluded when any sample is BELOW terrain (on-surface ships can still fire). `LOS_SAMPLES = 5`.
  - `resolveHit(shard, {weapon, sourceId, targetId, damagePoint})` →
    `{ok:true, shieldHit, hullHit, destroyed}` | `{ok:false, code}` with codes
    `self-target` / `unknown-source` / `unknown-target` / `dead-target` / `out-of-range` /
    `no-line-of-sight`. Validation order: self → source lookup → target lookup (wreck/destroyed
    = dead) → range (firing entity → damagePoint, `<=` boundary allowed) → LOS (only when either
    side's regime is not 'space'; sampled against the FIRING entity's planet via
    `shard.terrainHeightAt(planetId, x, z)` — pad disc flattened, same surface flight clamps to).
  - `CombatShard` interface (entities / applyHit / terrainHeightAt) so no circular import with SystemShard.
- `app/src/server/shard/shard.ts`:
  - `applyHit(targetId, amount, source, weaponId)` — weapon id now required (TASK-23 signature
    extended); broadcasts `{kind:'hit', target, source, weapon, damage, shieldHit, hullHit}`.
  - `destroyEntity(entity, source, weaponId)` — wreck gets `killerId: source.id`; broadcasts
    `{kind:'destroyed', target, source, weapon}` and, ONLY for a player source,
    `{kind:'kill', killer, victim, weapon}`.
  - NEW `handleWeaponContact(weapon, sourceId, targetId, damagePoint)` — the contact-callback
    contract (step 3); TASK-43's projectiles call exactly this on contact.
  - NEW public `terrainHeightAt(planetId, x, z)` (getTerrain + update + padSurfaceHeight).
  - `entityToState`: wrecks ride `killerId` on the wire (TASK-49's skull marker).
- `app/src/server/shard/types.ts`: `SimEntity.killerId?: string`.
- `app/src/shared/protocol/schemas.ts`: combat_event rewired to `hit` / `destroyed` / `kill`
  (weapon required on all three; kill = `{killer, victim, weapon}`); `COMBAT_EVENT_KINDS`
  updated; `EntityState` gained optional `killerId`. No client consumers existed (HUD is TASK-50).
- `app/src/shared/physics/damage.ts` — **substantive bug fix found by the integration test**:
  normalized hull fractions accumulate float error (a 30-pt-remaining hull can read as
  30.000000000000004), so an exactly-lethal hit reported `destroyed: false` and the ship lived
  at 1e-14 hull. `applyDamage` now compares `hullHit >= hull - DESTROYED_EPSILON` (1e-9,
  constant — still pure, still bit-identical client↔server).
- Tests:
  - `app/src/server/shard/shard.combat.test.ts` (NEW, 13): pure LOS math (incl. narrow-spike-
    between-samples NOT caught = the documented 5-sample approximation), seeded analytic-terrain
    ridge (deterministic ≥25 m ridge search around (2000..4200, 2000..4200) on `planets[0]` —
    behind-mountain occluded, +2000 m altitude clears, space skips LOS), full pipeline with
    EXACT event payloads, self/dead/unknown/out-of-range rejections, friendly-fire-ON with an
    ai-ship source.
  - `app/src/server/shard/shard.combat.ws.test.ts` (NEW): THREE live ws clients — two ships in
    open space (teleported to (60000,60000,0)/(60060,60000,0)) trade hits through
    `shard.handleWeaponContact`; the third client observes 4 exact `hit` payloads on B (the 5th
    shot is the killing one → `destroyed`), 2 on A, the `destroyed`, and the `kill`; victim conn
    gets `destroyed`; wreck `killerId` rides the 10 Hz `entity_update`; follow-up shot on the
    corpse → `dead-target`.
  - Updated for the new contract: `schemas.test.ts`, `shard.damage.test.ts` (applyHit now takes
    a weapon id; 'hit'/'destroyed' payloads; new player-kill test), `damage.test.ts` (epsilon
    boundary regression).
- `.ralph/logs/LOG.md`: TASK-42 entry added at top (numbers verified against the green run below).

## Working tree
- Everything in "Done" (8 modified + 4 new files under `app/src`, plus
  `.ralph/logs/LOG.md`) is committed in this session's `wip(TASK-42)` commit, together with
  this handoff. The task-flag files (`.ralph/tasks.json`, `.ralph/tasks/TASK-42.json`) were
  REVERTED to `passes: false` / `pass: false` per handoff instructions. Working tree clean.
- Builds clean: `npx tsc --noEmit` clean; eslint + prettier clean over all 12 touched files.
- Test evidence (all on this tree):
  - Full `npm run test` (background, quiet machine): **125 files / 1077 passed / 1 skipped, 0 red**.
  - Targeted: `shard.combat.test.ts` + `damage.test.ts` + `shard.damage.test.ts` +
    `schemas.test.ts` + `shard.combat.ws.test.ts` all green.
  - Known load-sensitive flakes under the ~125-file parallel load (documented in LOG history,
    pass in isolation): `mine.ws.test.ts` (timed out waiting for a character entity_update once),
    `multiplayer-foot.ws.test.ts` (scale tick p95), `surface.test.ts` (5 s timeout once).
    All three re-ran green in isolation on this tree (17/17 combined for the last two; mine.ws 4/4).
- No dev server or other background processes were left running (the background vitest runs
  were killed / finished).

## Next steps
Bookkeeping only, in order:
1. Re-verify: `cd app && npm run test` (~3.5 min — watch for the documented load flakes above;
   if one of those specific files reds, re-run it in isolation: `npx vitest run <file>`) and
   `npx tsc --noEmit`.
2. Set all 4 step `pass` flags to `true` in `.ralph/tasks/TASK-42.json` and `"passes": true`
   for TASK-42 in `.ralph/tasks.json` (the TASK-42 entry, `id: "TASK-42"`).
3. `.ralph/logs/LOG.md`: bump `**Tasks Completed:** 55` → `56`.
4. Commit (Conventional Commit, e.g. `feat(combat): TASK-42 — server-side hit resolver, LOS,
   hit/destroyed/kill events`) and delete this handoff file in the same commit.
5. Output `<promise>TASK-42:DONE</promise>`.

## Dead ends
- `WsTestClient` wrapper mixup in `shard.combat.ws.test.ts`: the local `join()` helper returns
  `{client, playerId, shipId}`, so event waiting is `c.client.next(...)`, not `c.next(...)`
  (TypeError: c.next is not a function).
- Hit-count expectation: 5 shots on B produce only 4 `hit` events — the 5th (killing) shot
  broadcasts `destroyed` INSTEAD of `hit`. Expect 4, not 5.
- The first `entity_update` consumed after the kill is usually a stale buffered snapshot from
  BEFORE the wreck existed (10 Hz cadence) — loop `next()` until a snapshot actually contains
  `wreck:<shipId>` (done in the test).
- Do NOT try to make the 5-sample LOS catch every spike: the narrow-spike-between-samples
  pass is the documented approximation (45° max slope, ≤ 2 km) and is asserted as such in
  `shard.combat.test.ts`.
- The 127-files/1081-passed figure that briefly appeared in a shell notification does not match
  the final green log (125/1077) — trust `/tmp/opencode/task42-full-test.log` and the
  completed-shell outputs, not notification snippets.

## How to verify
- `cd app && npx tsc --noEmit` → clean.
- `cd app && npx vitest run src/server/shard/shard.combat.test.ts src/server/shard/shard.combat.ws.test.ts src/server/shard/shard.damage.test.ts src/shared/protocol/schemas.test.ts src/shared/physics/damage.test.ts` → all green (~20 s).
- Full: `cd app && npm run test` → 125 files, 0 red (flake caveat above).
- Spot-check the wire contract: `grep -n "kind: z.literal" src/shared/protocol/schemas.ts | grep -A2 combat` — the three kinds `hit`/`destroyed`/`kill` are the contract TASK-47/49/50 will consume.
