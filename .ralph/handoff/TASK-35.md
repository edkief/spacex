# TASK-35 handoff — Re-entry: return to ship seamlessly

## Status

Implementation is complete and e2e-verified (full disembark → walk 10 m → walk back → re-enter cycle is green with all 4 phase screenshots); ONE stale test expectation in the old TASK-33 file fails the full unit suite (913 passed / 1 failed / 1 skipped), so `passes` is NOT set. This is a ~5-minute fix + re-verify + bookkeeping close-out, not implementation work.

## Done

All 3 spec steps are implemented and committed-as-WIP in this session:

- **Step 1 — server `enter_ship`**: `SystemShard.handleEnterShip(playerId, shipId, source)` in `app/src/server/shard/shard.ts` (added ~line 982). Validation order: not-found → not-owner (v1: owner only) → already-in-ship (idempotency: no `char:<playerId>` entity) → out-of-range (> 5 m from the CHARACTER position) → ship-moving (velocity >= 1 u/s). On success: deletes the character entity, clears `disembarked`, drops `heldInput` (no ghost thrust), un-idles, emits `entered-ship` event. `EnterShipOutcome` union added; `InteractOutcome` extended with the enter-ship codes; the `handleInteract` 'ship' branch now DELEGATES to `handleEnterShip` (no more TASK-35 stub). `routeGameMessage` in `app/src/server/shards.ts` routes the new `'enter_ship'` message (schema entry already existed in `src/shared/protocol/schemas.ts` line 279).
- **Shared tunables** (spec: constants in src/shared): `ENTER_SHIP_RANGE_M = 5` + `ENTER_SHIP_MAX_SPEED = 1` + `interactRangeFor(kind)` in `app/src/shared/interaction.ts`; `nearestInteractable` now uses per-kind reach when `range` is omitted (ship = 5 m, everything else 3 m). Client `resolveInteract` passes the same default.
- **Step 2 — client prompt + handoff**: registry ship entry in `app/src/client/input/interaction.ts` now sends `send('enter_ship', { shipId })` (prompt text '[E] Enter ship' unchanged, eligibility = own callsign only). `WorldManager.reEnterShip(pos, quat)` in `app/src/client/world/WorldManager.ts`: first call of the transition disposes the capsule + runs the reverse 600 ms camera handoff (`cameraRig.handoff('cockpit')`, the TASK-27 rig in reverse); later 10 Hz self updates just feed the pose. `main.tsx` self-entity bridge: `self.kind === 'ship'` → `world.reEnterShip(...)`, not-on-foot branch clears predictor + interaction prompt.
- **Step 3 — tests**: NEW `app/src/server/shard/shard.enter-ship.test.ts` (7 tests through the real SimLoop: happy path, idempotency, not-owner, 5 m boundary inclusive, 1 u/s boundary, idle-off-pad re-claim, not-found) and NEW `app/src/server/galaxy/enter-ship.ws.test.ts` (3 live-ws tests: round trip w/ no orphan character + position consistency + double-enter denial, not-owner player B, ship-moving). Both green.
- **E2E**: NEW `app/tests/e2e/enter-ship.spec.ts` — dock (raw WS) → browser disembarks (E) → spins 'd' until '[E] Enter ship' appears → walks W 10 m (prompt hides) → walks S back to start (prompt returns) → E → docked HUD stubs back, 600 ms reverse handoff to cockpit. **Green in 18.2 s.** Screenshots on disk: `.ralph/screenshots/TASK-35-1..4.png` (gitignored like the others).
- **Regression found + fixed this session**: the previous session's uncommitted `main.tsx` refactor had moved `charPredictorRef.current = null` OUTSIDE the if/else in the self-entity bridge — it cleared the character predictor on EVERY call including on-foot, so the prediction loop (the only sender of on-foot input frames) stopped: walking, turning, AND the interaction raycast all died (walk.spec.ts e2e was failing; `__CHAR__.rot` never changed). Fix: the clear + prompt teardown moved into the NOT-on-foot branch (see `main.tsx` ~line 475). `walk.spec.ts` e2e green again after the fix.
- Verified: `tsc --noEmit` clean; eslint + prettier clean on all touched files; the 4 directly-affected unit test files (shared/interaction, client/input/interaction, shard.enter-ship, enter-ship.ws) = 46 passed.

## Working tree

NOT committed (all of it):
- Modified: `app/src/shared/interaction.ts` + `.test.ts`, `app/src/server/shard/shard.ts`, `app/src/server/shards.ts`, `app/src/server/shard/shard.interact.test.ts` (WIP updated it for the delegation), `app/src/client/input/interaction.ts` + `.test.ts`, `app/src/client/main.tsx`, `app/src/client/world/WorldManager.ts`, `.ralph/tasks/TASK-35.json` (step pass flags left false — set them at close-out).
- New: `app/src/server/shard/shard.enter-ship.test.ts`, `app/src/server/galaxy/enter-ship.ws.test.ts`, `app/tests/e2e/enter-ship.spec.ts`, this handoff file.
- Untracked ralph artifacts left as-is (not mine): `.ralph/decisions.jsonl`, `.ralph/split/TASK-34/proposal.json`.

Builds: `tsc --noEmit` clean. Unit suite: **913 passed / 1 failed / 1 skipped (106 files)** — the one failure is the stale expectation below.

## Next steps

1. **Fix the one failing test** — `app/src/server/shard/shard.interact.test.ts`, test `'ship kind (TASK-35): a valid in-reach request re-enters the ship via the delegate'` (~line 320). It asserts `expect(shard.handleInteract('p1', 'ship-p1')).toBe('already-in-ship')` for a SECOND interact after the first already removed the character. That expectation predates the final validation order: `handleInteract` checks the on-foot regime FIRST (no `char:p1` → `'wrong-regime'`), so the second call returns `'wrong-regime'`. Change the expectation to `'wrong-regime'` and adjust the comment (the idempotent `'already-in-ship'` denial is owned by `handleEnterShip` directly — covered by `shard.enter-ship.test.ts` and `enter-ship.ws.test.ts`). (Verified by reasoning against `handleInteract`'s documented validation order; re-run to confirm.)
2. `cd app && npx vitest run src/server/shard/shard.interact.test.ts` (must go green), then full `npm run test` (~2 min, expect 106 files / ~914 passed / 1 skipped) + `npx tsc --noEmit`.
3. Re-run e2e to be safe: `cd app && npx playwright test --config playwright.e2e.config.ts enter-ship.spec.ts walk.spec.ts` (both were green this session; walk.spec.ts specifically guards the main.tsx predictor fix).
4. Bookkeeping: `.ralph/tasks.json` → `"passes": true` for TASK-35 (the TASK-35.json step flags are already set); LOG.md entry at top + bump 'Tasks Completed' 47 → 48 (mirror the TASK-34 entry's shape, reference screenshots TASK-35-1..4.png); delete this handoff file.
5. Commit as `feat(enter-ship): TASK-35 ...` (Conventional Commit) covering the src changes, the 3 new test files, and the ralph bookkeeping.

## Dead ends

- **Prompt never appearing while spinning** → root cause was NOT the enter-ship code: the previous session's `main.tsx` WIP cleared `charPredictorRef.current` unconditionally in the self-entity bridge, killing ALL on-foot input (walk.spec.ts e2e failed too). Fixed by scoping the clear to the not-on-foot branch. If you ever see "on-foot character ignores WASD/turn AND the interact prompt never shows", suspect this exact line before touching the interaction code.
- Spinning 'd' in the e2e is the robust way to face the ship: the character spawns 2.5 m to the ship's SIDE (world position depends on the ship's docked quat — it's yawed ~90° in the seeded pad, so the ship ends up ahead-ish, but the code must not assume); the ±30° cone misses at spawn, and 'd' turns at 3 rad/s so the first revolution always sweeps the cone across a 2.5 m hull. Don't hardcode a facing direction.
- The e2e "walk back" must return to the START position (within 0.6 m), not walk a fixed time backward — a fixed backward distance overshoots the ship (it's 2.5 m ahead, walking 10 m back puts you ~7.5 m past it, outside the 5 m radius).
- The on-foot third-person view does NOT show the ship (verified against the committed TASK-31-1.png reference) — don't chase "ship invisible in screenshot" as a bug.
- `waitForFunction` helpers: pass ONE combined arg object (`{s, d}`) — Playwright passes a single arg; the first draft of the spec passed two and type-checked wrong.

## How to verify

```
cd /workspace/master/app
npx tsc --noEmit                                              # clean
npx vitest run src/server/shard/shard.interact.test.ts        # green after step 1 fix
npm run test                                                  # full: ~914 passed / 1 skipped
npx playwright test --config playwright.e2e.config.ts enter-ship.spec.ts walk.spec.ts   # both green (~30 s total)
```
Visuals: `.ralph/screenshots/TASK-35-1.png` (on foot, '[E] Enter ship' prompt), `TASK-35-2.png` (10 m away, prompt gone), `TASK-35-3.png` (back at the ship, prompt returned), `TASK-35-4.png` (cockpit: E LEAVE SHIP + DOCKED HUD, weight bar still up — inventory HUD follows the player per TASK-34).
