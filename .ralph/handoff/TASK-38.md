# TASK-38 Handoff — Mining: on-foot deposit extraction with a channel

## Status

Implementation (steps 1–3) is essentially complete in the working tree and `tsc` is clean; the
pure-math + shard state-machine unit tests pass (16/16). What remains: one 1-line server fix for a
known failing test, a root-caused test-setup bug in `shard.deposits.test.ts`, the WS integration
test file, the e2e spec + screenshot, and the standard verification/booking pass (step 4).

## Done

**Server (`app/src/server/shard/shard.ts`)** — full mining state machine, all wired:
- `readonly mining = new Map<string, MiningChannel>()` (playerId → channel).
- `handleMine(playerId, target, action, source)` replaces the old v1 `applyPickup`: the `'deposit'`
  branch of `handleInteract` now delegates to it. `'mine-stop'` ends the channel (reason
  `'stopped'`); `'mine-start'` / `'mine-tick'` / `'pickup'` ensure a channel (start / idempotent
  re-assert / switch-deposit-cancels-old); any other action → new `'invalid-action'` denial.
  New `'invalid-resource'` denial when the deposit has no known `resourceId`.
- `updateMining(tick)` (called from `tick()`, the ONLY award path): per channel — character gone
  → `'cancelled'`; deposit gone → `'depleted'`; distance > `INTERACT_RANGE_M` (checked per tick) →
  `'cancelled'`; else `stepMiningChannel` → award (atomic deposit −1 / inventory +1, `mine` event,
  seed-deposit persist via `persistDeposit`, despawn + `'depleted'` at 0) or `'full'` pause at the
  weight cap (`lastAwardAt` deliberately NOT advanced — the held award lands next tick). 10 Hz
  progress echo (`tick % SNAPSHOT_EVERY_TICKS === 0`) to the miner only.
- `sendMining` / `sendMiningActive` / `sendMiningEnd` — per-connection `'mining'` frames
  (wire-validated; stale-conn guarded).
- `leave`/`unregisterConnection` kills the channel on disconnect.
- `addDepositForTesting(pos, quantity, resourceId = 'iron')` gained the resource param.
- `InteractOutcome` extended with `'invalid-action' | 'invalid-resource'`.
- TS error at the `isResourceId(target.resourceId)` call fixed (`!target.resourceId || !isResourceId(...)`).

**Shared**: `app/src/shared/mining.ts` (NEW) — `MINING_UNIT_MS = 1500`, `MiningChannel`,
`stepMiningChannel` (pure; reuses TASK-34 `pickupInto` for the cap math).
`app/src/shared/protocol/schemas.ts` — NEW server→client `mining` discriminatedUnion frame
(`phase: 'active' {depositId, progress 0..1, units, status: 'mining'|'full'}` |
`phase: 'ended' {depositId, reason: 'stopped'|'cancelled'|'depleted', units}`);
`schemas.test.ts` has the mining case.

**Client**:
- `input/interaction.ts` — deposit entry now `mine-start` on E-down / `mine-stop` on E-up
  (new optional `InteractableEntry.onRelease`), registry gained `release(target, send)`; prompt is
  now `Hold [E] to mine <resourceId>`.
- `main.tsx` — E keydown (ignores `e.repeat`) dispatches + stores `heldInteractRef`; NEW E keyup +
  window blur handlers release it; `onMining` session callback feeds `state/mining.ts`;
  `<MiningHud />` rendered after `<WeightBar />` in the App JSX.
- `state/mining.ts` (NEW) — subscribe/emit store fed ONLY by server frames; gain float fires when
  the unit counter advances on the same deposit. `ui/mining-hud.tsx` (NEW) — radial conic-gradient
  ring, ore counter, `+1 <resource>` float, 'Backpack full' / 'Depleted' prompts, `#mining-hud`.

**Tests**:
- NEW `app/src/shared/mining.test.ts` — 5 tests, PASSING.
- NEW `app/src/server/shard/shard.mining.test.ts` — 11 tests, ALL PASSING (fake clock via the
  shard `now:` option + `advance(shard, ms)` stepping `shard.sim.step(fakeNow)` every 50 ms):
  cadence, anti-spam (20 mine-ticks in 1 s = no gain), cancel, range-loss, re-entry cancel,
  disconnect kill, weight-cap pause + held award, depletion despawn, two-miner atomicity,
  resource types, deposit switching.
- UPDATED `app/src/client/input/interaction.test.ts` (mine-start frame, release test, new prompt
  strings) — edited, not re-run since.
- UPDATED `app/src/server/shard/shard.interact.test.ts` (fake clock + `advance`, deposit tests now
  channel-based) and `app/src/server/shard/shard.deposits.test.ts` (`mine()` helper now runs the
  channel through ticks) — both have KNOWN FAILURES, see Next steps.
- `app/src/server/routes/dev.ts` — `POST /api/dev/deposit` accepts `resourceId`.

## Working tree

NOTHING committed — all of the above is uncommitted (modified: interaction.ts/.test, main.tsx,
dev.ts, shard.ts, shard.deposits.test.ts, shard.interact.test.ts, schemas.ts/.test; new:
shared/mining.ts + .test, shard.mining.test.ts, state/mining.ts, ui/mining-hud.tsx). `tsc --noEmit`
(app dir) is CLEAN. No background processes were left running.

Known failing at time of handoff (last run: `npx vitest run` on the 3 shard files):
1. `shard.interact.test.ts` "out-of-range… exactly 3 m passes": `handleInteract('p1', edge)` with
   NO action returns `'invalid-action'` (test expects `'ok'` → channel start).
2+3. Both persistence tests in `shard.deposits.test.ts`: zero units mined — root cause below.

## Next steps

1. **1-line server fix** in `shard.ts` `handleMine`: allow an ABSENT action to start the channel
   (back-compat, and the interact test relies on it):
   change `if (action !== 'mine-start' && action !== 'mine-tick' && action !== 'pickup') {`
   to `if (action !== undefined && action !== 'mine-start' && action !== 'mine-tick' && action !== 'pickup') {`
   then re-run `npx vitest run src/server/shard/shard.interact.test.ts` (expect green).
2. **Fix the `shard.deposits.test.ts` character-fall bug** (see Dead ends for the evidence +
   leading hypothesis). Cleanest likely fix: replace that file's manual `onFootAt` (addEntity ship
   + character) with the REAL dock-then-`handleExitShip` flow — the `onFootAtPad` helper in
   `shard.interact.test.ts` (drive input frames until `entity.padId === PAD.padId`, then
   `shard.handleExitShip('p1','ship-p1')`) — which is proven not to fall (shard.mining.test.ts's
   manual entities don't fall in THAT system, so this is setup/seed specific). Keep the injected
   fake clock (`now: () => fakeNow`) + `advance`.
3. `npx vitest run src/client/input/interaction.test.ts` (edited, unverified) + full `npm run test`.
4. **`app/src/server/galaxy/interact.ws.test.ts`** still asserts the OLD tap semantics — rewrite
   test 1 as hold-to-mine: `mine-start` → wait for the private `'mining'` active frame (A only —
   B's buffer must contain ZERO `mining` frames) → quantity 2→1 on the shared snapshot for BOTH
   (10 s timeouts cover the 1.5 s real-time cadence) → `mine-stop` → `phase:'ended' reason:'stopped'`
   → drainQuiet (helper already in the file) → second hold → despawn + `reason:'depleted'`.
5. **NEW `app/src/server/galaxy/mine.ws.test.ts`** (live ws, real time; copy the boilerplate from
   `interact.ws.test.ts` — claim/arriveAtPad/onFoot/addDepositForTesting): full channel + cancel,
   spam 20 `mine-tick` in ~1 s → exactly floor-expected (1) unit, weight-cap pause
   (`giveInventoryForTesting('p1', {iron:40})` → active echo `status:'full'` → `drop` 1 iron →
   award lands), two-miner over the wire (1-unit deposit, both `mine-start`, exactly one `units:1`).
   Weight-cap/depletion/two-miner can also live only in shard.mining.test.ts (already there) if
   time is tight — but the AC names them for the WS layer.
6. **NEW `app/tests/e2e/mining.spec.ts`** (mirror `tests/e2e/inventory.spec.ts`): raw-WS claim →
   pad-target → dock → disembark → close → browser on foot → wait `window.__CHAR__` (deposits.spec.ts
   pattern) → `POST /api/dev/deposit` at `__CHAR__.pos + (0,0,1.5)` quantity 5 (default iron) →
   wait for `Hold [E] to mine iron` prompt → `page.keyboard.down('e')` → `#mining-hud` visible →
   screenshot `.ralph/screenshots/TASK-38-1.png` mid-channel → wait for `#weight-bar` to read
   2/40u (2 units ≈ 3.2 s; give 15 s) → `keyboard.up('e')` → HUD ring hidden →
   `.ralph/screenshots/TASK-38-2.png` → `assertClean()`. Identity facing is +Z, so the deposit at
   z+1.5 is in the 30° cone (deposits.spec.ts uses the same trick).
7. Finish: `eslint --fix` + `prettier --write` on touched files, `npm run test` green,
   `tsc --noEmit`, run the new e2e, flip the 4 step flags in `.ralph/tasks/TASK-38.json` +
   `passes: true` in `.ralph/tasks.json`, LOG.md entry (newest first, bump Tasks Completed 51 → 52),
   delete this handoff, Conventional Commit, `<promise>TASK-38:DONE</promise>`.

## Dead ends

- **`shard.deposits.test.ts` zero-mining — ROOT-CAUSED (evidence, from tsx repro scripts):** the
  manually-added `char:p1` (at the seeded deposit's pos + z1, `regime:'surface'`,
  `planetId:'planet-dep'`) FREE-FALLS during `shard.sim.step` (y 234 → ~198 over 1.6 s fake time,
  `charOnGround: false`, gravity 12 m/s²) → per-tick range check > 3 m → channel cancelled
  (`reason: 'cancelled'`) → zero units. But calling the shard's private `resolveRegimeCtx(entity)`
  DIRECTLY returns the REAL ctx (`heightAt(char) = 234.2`, planet present), and running
  `integrateCharacter` manually with that ctx keeps the character grounded at 234.2. Inside the
  tick, however, a wrapped `resolveRegimeCtx` logs the character call with
  `entity.ship.regime === 'space'` AND `entity.planetId === undefined` → the EMPTY ctx
  (`heightAt: () => 0`) → free fall. So the tick integrates an entity state that differs from what
  was stored by `addEntity` (which provably kept `planetId: 'planet-dep'` / `regime: 'surface'`).
  LEADING HYPOTHESIS: `addEntity` also registers the character in `this.playerEntities` (or the
  sys-deposits `aiRoster: {count:1}` AI entities interact), so the SHIP loop
  (`for (const entity of this.playerEntities.values())`, shard.ts ~line 700) integrates the
  character AS A SHIP (it's not `disembarked`), and `this.resolveRegime(entity)` rewrites its
  regime/planetId to space/undefined — the real flow never hits this because `handleExitShip` sets
  `ship.disembarked = true` (ship loop skips disembarked ships) and the character is created by
  `handleExitShip`, not `addEntity`. NOTE: this is a TEST-SETUP artifact, not a production bug —
  verify with the real dock+exit-ship flow before touching production code. Also note the tick log
  showed 3 such EMPTY character calls, suggesting AI-roster characters may be involved.
- The `advance(shard, ms)` window math: `while (fakeNow < end)` lands the final tick EXACTLY at
  `start + ms`, so a 1450 ms window that ends on the 1500 ms boundary DOES award — the
  "nothing before 1.5 s" assertions must end windows < 1500 ms after the anchor
  (shard.mining.test.ts uses 1400 + 100 for this reason; the first version failed for exactly this).
- `npx tsc` at the REPO ROOT installs a bogus `tsc` npm package — always use
  `app/node_modules/.bin/tsc --noEmit` (or `npm run typecheck` in `app`).
- `shard.mining.test.ts` had a parse error from an apostrophe inside a single-quoted `it('...')`
  title ("deposit's") — use double quotes there.

## How to verify

```
cd /workspace/master/app
npx vitest run src/shared/mining.test.ts src/server/shard/shard.mining.test.ts   # 16/16 PASS now
npx vitest run src/server/shard/shard.interact.test.ts src/server/shard/shard.deposits.test.ts  # 3 known fails (see above)
npm run test          # full unit suite (was 113 files / 964 passed / 1 skipped at HEAD)
npm run typecheck     # clean at handoff time
npx playwright test --config playwright.e2e.config.ts tests/e2e/mining.spec.ts   # after step 6
```
