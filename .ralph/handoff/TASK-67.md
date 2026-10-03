# TASK-67 handoff — cheat-resistance suite: shipped, one full-suite red left to settle

## Status
All four deliverables are implemented, committed and green in isolation (`tests/abuse/` 3 specs + the new
sell-concurrency unit test), and the suite found two REAL holes that are fixed in production
(`handleSell` credit duplication, `repo.withTransaction` overlapping BEGIN). TASK-67 is NOT closed:
the full `npm run test` shows one red — `src/server/galaxy/multiplayer-foot.ws.test.ts` → "scale: 4 on
foot + 4 in ships — tick p95 … all four walk" — which passes 3/3 in isolation. Close-out flags were
reverted (`passes: false`, step `pass: false`, LOG counter back to 59); the LOG entry was kept and
retitled WIP.

## Done
Commit `1f7f4c4` — `test(security): TASK-67 — cheat-resistance suite + two sell-path fixes`
(wip flags reverted by the follow-up `wip(TASK-67)` commit).

- **Production fix 1 — credit duplication (`app/src/server/shard/shard.ts`, `handleSell`, ~line 2117).**
  The in-memory apply (`ship.cargo = res.hold; ship.inventory = res.inv; syncCharacterInventory`) ran
  AFTER `await repo.withTransaction(...)`, so N concurrent sells on one socket all read the same
  pre-sell stacks and each got paid. Measured on the real wire: 10 granted iron + 100 rapid sells →
  **+200 credits for 4 units actually removed** (iron is 5 cr/unit → 40 units paid for 10).
  Now: capture `prevCargo`/`prevInventory`, apply synchronously BEFORE the commit await, restore them
  in the `catch` (plus `syncCharacterInventory`) so the atomicity AC still holds. The redundant post-commit
  apply was deleted.
- **Production fix 2 — overlapping BEGIN (`app/src/server/db/repo.ts`, `createRepo`).**
  New `let txLane: Promise<unknown> = Promise.resolve();` (~line 247) and `withTransaction` (~line 570)
  now takes a turn: `const waitForTurn = txLane.catch(() => undefined); txLane = new Promise(r => {release = r});
  await waitForTurn; … finally { release(); }`. Before: a second caller got
  `DrizzleError: Failed to run the query 'BEGIN'` → 20 `sell-failed` frames in the sell burst.
- **`app/tests/abuse/rawClient.ts`** — raw-ws harness: `send(type,payload)`, `sendRaw(bytes)`,
  `next(predicate, what, ms)`, `waitForClose(ms)`, `count(type)`, `errors(code?)` (code now optional),
  `closeCode`/`closeReason`, `closed`, plus `nestedPayload(depth)`.
- **`app/tests/abuse/abuse.spec.ts`** — 8 scenarios on the real wiring, ALL GREEN (~30 s):
  1 teleport (`pos` claim → `invalid-message`, `teleport` → `unknown-type`, honest travel bounded by
  `SHIP_CLASSES.scout.maxVelocity`), 2 hit claims (no `hit`/`damage` type, B untouched),
  3 fire spam (`weapon-locked`, exactly one `laser-fired` + one hit, B at `1 − 8/50`),
  4 mine spam (20 ticks/s for 3.2 s → `ended.units === 2`, deposit 8, inventory 2),
  5 sell spam (see below), 6 warp spam (one `warp_arrived`, rest `invalid-message`, one entity),
  7 flood (1000 pings → `rate-limited` then close **4009 'flooded'**), 8 payload abuse
  (70 KB / non-JSON / depth-40 → `invalid-message`, conn survives, handshake still works).
- **`app/tests/abuse/property.spec.ts`** — 1000 seeded sequences × 3–5 schema-valid messages, invariants
  after EVERY sequence (iron conservation, `credits == 500 + Σ earned`, `≤ 500 + sold × price`,
  no negatives, ≤ 16 projectiles, < 1000 entities). **Green in ~0.7 s.**
- **`app/tests/abuse/audit.spec.ts`** — 15 tests, GREEN (WS schema coverage, REST manifest two-way via an
  `onRoute` hook, limiter registry + pinned constants).
- **`app/src/server/shard/shard.sell.test.ts`** — added the regression for fix 1: `Promise.all` of 20
  concurrent `handleSell`s over 10 units → exactly 10 sold, `state.credits === 500 + 10 * 5`,
  hold 0, 10 × `insufficient`. File: 8/8 green.
- Type fixes that were needed (`npx tsc --noEmit` is clean now): `PlayerRow` comes from
  `@server/db/schema` (NOT `@server/db/repo`); `SimEntity.inventory` is FLAT `InventoryStacks`
  (`ship.inventory?.iron`, NOT `.stacks.iron`) while `SimEntity.cargo` is a `CargoHold` (`.stacks.iron`);
  the repo balance reader is `repo.getBalance(playerId)`; `new Promise<void>((resolve) => …)` in rawClient.

## Working tree
- Committed: everything above (`1f7f4c4` + the flag-reverting `wip(TASK-67)` commit).
- NOT committed: `opencode.json` (pre-existing local modification, unrelated to TASK-67 — leave it).
- Builds clean: `npx tsc --noEmit` no output; eslint + prettier clean on every touched file.
- Full `npm run test`: **131 files / 1139 passed / 1 failed / 1 skipped** — the one red is
  `src/server/galaxy/multiplayer-foot.ws.test.ts > … > scale: 4 on foot + 4 in ships — tick p95 stays
  within baseline + 4 ms, all four walk`, assertion at line ~452:
  `AssertionError: expected 0 to be greater than 1` (a walker's `char:<id>` position never moved).
  Same file passes 4/4 in isolation (verified 3×). Baseline before this task was 128 files / 1115 passed.
- No dev server or vitest process left running (port 3000 free).

## Next steps
1. **Settle the one red.** It failed in BOTH full-suite runs and passes in isolation, so first decide
   flake vs. regression:
   `cd app && npx vitest run src/server/galaxy/multiplayer-foot.ws.test.ts tests/abuse/` → green
   (already verified). Then `git stash` nothing — instead run the full suite with the abuse specs
   temporarily excluded:
   `npx vitest run --exclude 'tests/abuse/*' src/server/galaxy/multiplayer-foot.ws.test.ts src/server/**/*.test.ts`
   (or edit `app/vitest.config.ts` `include` for one run). If it goes green only without the abuse
   specs, the abuse suite is starving the pool — mitigation options: give `tests/abuse/abuse.spec.ts`
   `describe.sequential`, cut its sleeps, or move the abuse specs into a separate `npm run test:abuse`
   script. If it stays red, bisect MY two changes: revert only the `txLane` in `app/src/server/db/repo.ts`
   (the shard flush shares that connection) and re-run.
   Note the assertion is `dist(now, charStarts.get(id)) > 1` after a 5 s held-input window, so a
   position RESET (shard rehydration/persist reload) also produces exactly 0 — check whether the shard
   reloaded during the window before blaming movement.
2. **Close-out once the full suite is green** (revert of what I had to back out):
   - `.ralph/tasks/TASK-67.json`: set all 4 `steps[].pass` to `true`.
   - `.ralph/tasks.json`: TASK-67 `"passes": true` (line ~477).
   - `.ralph/logs/LOG.md`: drop ` (WIP — full suite not green yet)` from the TASK-67 heading, update the
     **Verify** bullet with the real final numbers, bump `**Tasks Completed:** 59` → 60.
   - Delete `.ralph/handoff/TASK-67.md`, commit (Conventional Commit), output
     `<promise>TASK-67:DONE</promise>`.
3. `.ralph/STRUCTURE.md` already lists `limiter-registry.ts`; `tests/abuse/` is test-only → excluded per
   the existing rule. No further STRUCTURE work.

## Dead ends
- **Do NOT assert the sell burst drains the inventory to 0.** The transport bucket (20/s, burst 40)
  drops most of the 100 frames, so only a few sells are ever admitted; asserting 0 remaining failed for
  a legitimate reason. Scenario 5 now asserts the real invariant: `balance == start + sold × price`,
  `sold ≤ 10`, `10 − inventory == sold`, ≥ 1 `rate-limited`/`insufficient`. A burst may also cost the
  connection (flood kick) — asserting `c.closed === false` failed and was removed (scenario 7 owns that).
- `shipOf(playerId, systemId)` returns the FIRST entity with that playerId — that can be the on-foot
  character; harmless because `syncCharacterInventory` points the character at the SAME inventory object,
  but do not "fix" the property test to count both entities: that double-counts iron.
- `addEntity` for the character overwrites `playerEntities[playerId]` → every sell returns
  `unknown-ship`. Characters must be inserted with `entities.set('char:<id>', …)` (production does).
- The property test must stay inside the 300 s ground-item ttl (50 ms per message × ≤ 5 per sequence);
  a 100 ms advance broke iron conservation for a legitimate ttl despawn.
- Zero-thrust input frames only in the property generator: a held thrust-1 frame walks the character off
  the terminal forever and silently disables the mine/sell/cargo paths.
- Close code stays **4009 'flooded'** (TASK-65 shipped + asserted in `ratelimit-flood.test.ts`); the tech
  note's 4001 'rate-limited-kick' would be a breaking protocol change for no security gain. Do not
  re-litigate.
- Fastify has no `routes()` lookup in this version — `app.routes()` did not work; the audit spec captures
  routes with an `onRoute` hook registered BEFORE `registerApiRoutes`.

## How to verify
- `cd app && npx vitest run tests/abuse/` → 3 files green (property ~0.7 s, audit ~0.04 s, abuse ~30 s).
- `cd app && npx vitest run src/server/shard/shard.sell.test.ts` → 8 passed.
- `cd app && npx vitest run src/server/galaxy/multiplayer-foot.ws.test.ts` → 4 passed (isolated).
- `cd app && npx tsc --noEmit` → no output.
- `cd app && npm run test` → must reach 0 red (currently 1: see Next steps 1).
- Acceptance map: AC1 abuse.spec.ts · AC2 property.spec.ts · AC3 audit.spec.ts WS section ·
  AC4 audit.spec.ts limiter section + `src/server/limiter-registry.ts` · AC5/AC6 the green runs.
