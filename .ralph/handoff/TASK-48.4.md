# Handoff: TASK-48.4 — Hazards e2e (storm screenshot) + TASK-48 close-out

## Status

hazards.spec.ts is committed, green in isolation (5.7/6.8/10.9 s) AND green in BOTH full-suite runs this session (12.9 s run #1, again run #2). Screenshot committed. **The full e2e suite has never COMPLETED: `globalTimeout: 5 * 60 * 1000` in `app/playwright.e2e.config.ts` is smaller than the current suite length (32 spec files, ~28 specs, ≈ 6+ min at 1 worker)** — run #1: 5 failed / 18 passed / 11 did not run (5.0 m exactly); run #2 (after the interact fix): **20 passed / 1 failed (mining, 31 s load-timing flake — green in isolation and in a 5-spec combo) / 13 did not run (5.0 m exactly)**. walk.spec.ts has NEVER executed to completion in any full run. Close-out is STAGED (parent spec restored, STRUCTURE.md updated) but flags/board/log NOT flipped — only flip after a full run completes green.

## Done (committed with this wip)

- `app/tests/e2e/hazards.spec.ts` — the e2e spec (drain assertion + storm screenshot + clean console). Verified green in isolation 3× and in both full runs.
- `.ralph/screenshots/TASK-48-1.png` — storm quads filling the view + amber ☢ exposure bar draining (verified by eye).
- `app/tests/e2e/interact.spec.ts` — **fix for a PRE-EXISTING red spec (stale since TASK-38)**: it asserted the v1 `'[E] Take ore'` prompt + single-press pickup, but TASK-38 replaced deposit pickup with hold-to-mine (`Hold [E] to mine iron` + 1.5 s server channel). Updated: prompt text assert → `Hold [E] to mine iron`; pickup step → `keyboard.down('e')` → `#mining-hud` visible → wait 1.8 s (one full 1.5 s channel tick awards the single unit → despawn) → `keyboard.up('e')` → prompt hidden. Verified green: 9.0 s in isolation, AND green in full run #2. (It had been red in every full run — run #1 failed it at 23 s. Unrelated to hazards, but the rule is "broke unrelated test? fix it before proceeding" and it blocked the full-suite gate.)
- `.ralph/tasks/TASK-48.json` — parent spec RESTORED from `.ralph/split/TASK-48/TASK-48.json` (verbatim copy, all 4 steps flipped `pass: true`; split dir left untouched per task note). Staged for the close-out commit.
- `.ralph/STRUCTURE.md` — added: `shared/world/hazards.ts`, `client/state/hazards.ts`, `client/ui/hazard-hud.tsx`, `client/hazard-debug.ts`; extended the `server/routes/dev.ts` line with the TASK-48.2 `GET /api/dev/hazard-target` route. (Test files excluded — the doc excludes tests.)

## Working tree

- Do NOT commit (pre-existing dirty, other tasks): ~25 modified `.ralph/screenshots/*.png` (except TASK-48-1.png / TASK-33-1.png which are this task's), `.ralph/decisions.jsonl` if modified, untracked `.ralph/split/TASK-46/`.
- Build state: tsc green; unit suite green (150 files / 1359 passed / 1 skipped — last verified session before this one; re-run before flipping flags). eslint/prettier clean on both touched specs.
- No background servers left running (the playwright fixture kills its own; no dev server was started).

## Next steps (in order)

1. **Bump the e2e global timeout** (e2e wiring = in scope): `app/playwright.e2e.config.ts` line 26 `globalTimeout: 5 * 60 * 1000` → `15 * 60 * 1000` (update the comment on lines 24-25 — it says "13 specs ≈ 2–3 min" which is stale; there are 32 files now). Per-test `timeout: 30_000` stays.
2. **Run the FULL suite**: `cd app && npx playwright test -c playwright.e2e.config.ts` (≈ 8-10 min — run it early, budget the rest of the iteration around it). This is THE gate (handoff rule step 1): if green (ideally twice in a row — the mining 31 s load-flake may need a re-run; mining/cargo/enter-ship/multiplayer-ship-projection all failed or stretched under accumulated SwiftShader load in run #1 — documented load-sensitive family per the TASK-46 precedent), the `hazards → walk` 2-spec combo failure stays an UNVERIFIED hypothesis: in both full runs hazards was immediately followed by inventory ✓, and walk was never reached. If walk now completes GREEN in the full suite, document the 2-spec combo as the flake family, note it in the LOG entry, and go to step 4.
3. **If walk fails in the full suite** (the original repro): re-add the shard instrumentation from the EARLIER handoff below (exact 3-line instrumentation + DBGCHAR-gated character-loop log in `app/src/server/shard/shard.ts`, revert before committing); boot the repro server with `DBGCHAR=1 ... SYSTEM_INSTANCE_COUNT=1`; rebuild `/tmp/repro-walk.mjs` from the two playwright patterns (chromium + raw ws, must sit inside `app/`). Evidence trail already gathered (still valid): the stuck player's character ticks with `playerConns` lookup MISSING / `conn=N held=N` (shard.ts ~1714: `this.playerConns.get(entity.playerId)` → undefined → zero input); connId `c1` was issued to BOTH A's and B's raw clients for the same system = TWO shard instances in one run (fresh `connSeq`) — suspects: `createGalaxyRouter` create/reap path (`app/src/server/galaxy/router.ts`), gateway enter (`gateway.ts`), unregister-on-close (`ws.ts` / `shards.ts`). NOTE from the earlier session: the fixture server default is `SYSTEM_INSTANCE_COUNT=3` (repro used 1), and the fixture is WORKER-scoped — one server across all spec files in the worker, so cross-spec pollution via a long-lived shared router IS the model. Scope: e2e-wiring fixes in scope; server-shard fixes only with a minimal fix after re-reading `.ralph/split/TASK-48/handoff.md` (the committed server suite is the spec of record), documented in the LOG.
4. **Close-out (only after step 2 is green):**
   a. `.ralph/tasks.json` ~line 560: TASK-48.4 `"passes": false` → `true`. There is NO parent TASK-48 board entry (only 48.1–48.4) — matches the TASK-25/26/28 split precedent; leave the board as-is, note it in the LOG.
   b. `.ralph/tasks/TASK-48.4.json`: all 3 steps `pass: true`.
   c. `.ralph/logs/LOG.md`: newest-at-top entry for TASK-48.4 + TASK-48 close-out (mention: hazards spec + screenshot, the interact.spec.ts stale-prompt fix, the globalTimeout bump, the full-suite result incl. any load-flake notes, the 2-spec combo status); bump `Tasks Completed` 70 → 71; update `Current Task` line to TASK-49 (the next pending task).
   d. Delete `.ralph/handoff/TASK-48.4.md` in the close-out commit.
   e. Final verify: `npx tsc --noEmit` + full `npm run test` green; eslint/prettier on touched files.
5. **Commit ONE final commit** (Conventional Commit, e.g. `test(e2e): hazards storm e2e + suite timeout bump (TASK-48.4)`): hazards.spec.ts already committed — include interact.spec.ts fix (if not already in the wip), `.ralph/tasks/TASK-48.json`, `.ralph/tasks/TASK-48.4.json`, `.ralph/tasks.json`, `.ralph/logs/LOG.md`, `.ralph/STRUCTURE.md`, the globalTimeout config edit, TASK-48-1.png + TASK-33-1.png (both this task's screenshots), delete the handoff. Do NOT sweep other tasks' dirty screenshots. Then `<promise>TASK-48.4:DONE</promise>`.

## Dead ends

- Waiting for the 5-min-globalTimeout full run to "complete" — it CANNOT (28 specs ≈ 6+ min). Bumping globalTimeout is mandatory, not optional, before any full-suite verdict.
- `stepHazardExposure` and the client input loop as suspects for the walk combo failure — ruled out in the earlier session (per-player state; B's page has no errors, character frozen server-side).

## An earlier handoff (superseded except the instrumentation details in step 3)

- Iteration 3 record: "the agent ran out of time; full e2e run shows 5 failed / 11 did not run (global timeout at 5 min) / 18 passed; fixture is worker-scoped (one server across files in the worker); SYSTEM_INSTANCE_COUNT defaults to 3 in the fixture." Its last messages confirm: only the router creates shards; two shard instances for one system in one run implies reap-then-recreate OR multiple server instances.
