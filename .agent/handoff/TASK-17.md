# Handoff — TASK-17: Reconnect and full state resync

## Status
Implementation (steps 1+2, server AND client) is written and in the working tree; unit tests for the shard changes are written. **Nothing has been run yet in this session** — no `tsc`, no `npm run test`, no lint, no Playwright. Step 3 (the WS integration test file) was NOT written. Task is ~70% done.

## Done
All in the working tree (uncommitted → will be in the wip commit):

**Server (step 1 — idle continuation + stale-conn guards):**
- `app/src/server/shard/types.ts` — `ConnState.source?: unknown` (opaque WS Conn identity); `SimEntity.idle?: boolean`.
- `app/src/server/shard/shard.ts`:
  - **tick() rewritten**: iterates `this.playerEntities` (all player ships) instead of `this.connections` — owner-less ships now keep integrating (coast on zero input; held frame already cleared on leave). This is the behavior change that makes "ship keeps living in the shard" true.
  - `registerConnection(playerId, callsign, send, source?)` — SUPERSEDES a zombie conn for the same player (evicts it from `this.connections`, debug log 'superseded stale connection'); stores `source`; un-idles an existing entity.
  - `unregisterConnection(connId)` — only deletes `playerConns` entry + marks entity idle when it is still the CURRENT connId; otherwise debug log 'dropped stale connection on leave' (entity untouched). Still emits 'player-left' (no listeners exist — verified).
  - `leavePlayer(playerId, source?)` — source mismatch → debug log 'ignored leave from stale conn', no-op.
  - `enqueueInput(playerId, payload, source?)` — source mismatch → debug log 'dropped input from stale conn', returns false.
  - `adoptEntity` — sets `entity.idle = !playerConns.has(playerId)` (re-adopt of an existing entity on reconnect = no duplicate entity, un-idle).
- `app/src/server/galaxy/router.ts` — `RouterPlayer.source?: unknown`; `enter` passes it to `registerConnection`; `leave(systemId, playerId, source?)` → `shard.leavePlayer(playerId, source)`.
- `app/src/server/galaxy/gateway.ts` — `leaveSystem` passes `player.source`.
- `app/src/server/ws.ts` — `GatewayPlayer.source?: unknown`; join_system builds player with `source: conn`; socket close handler passes `source: conn` to `gateway.leaveSystem`.
- `app/src/server/index.ts` — input routing now `shard.enqueueInput(conn.playerId, payload, conn)`.

**Client (step 2 — auto-retry + resync):**
- `app/src/client/net/session.ts` — **fully rewritten** (was 128 lines, now ~330; may need splitting per 200-300 line rule): `ClientSession` gained lazy `dial()` (socket created on connect(), not in constructor), `ConnectionState` ('connecting'|'connected'|'reconnecting'|'lost'|'closed') with `onState`, `onSnapshot(snapshot, reconnect)` fired on EVERY enter_system (initial join has `reconnect=false`), constants `RETRY_BASE_MS=1000 / RETRY_CAP_MS=5000 / RETRY_GIVE_UP_MS=30000` (exponential 1,2,4,5,5…; 'lost' after 30 s down but retries KEEP running in background; `retryNow()` dials immediately + re-arms patience). Auto-reconnect only after first successful join (initial-join failure stays the caller's error path). Rejoin-failure (error frame during autoJoin) closes the socket so the close path retries.
- `app/src/client/net/chat.ts` — `ChatStore.mergeSnapshot(entries)`: appends only entries newer than the local tail (resync without reset), ring cap kept, no-op when nothing new.
- `app/src/client/net/presence.ts` — `PresenceToast.kind` += 'reconnected'; `PresenceStore.reconnected()` fires that toast (list untouched).
- `app/src/client/hud/toast-stack.tsx` — `toastText()` renders "reconnected" for the new kind.
- `app/src/client/main.tsx` — `useGameSession` returns `{ systemId, connState }`; snapshot handling moved into `onSnapshot` (reconnect + same systemId → `applySnapshot` + `mergeSnapshot` + `store.reconnected()` = no UI reset; else full boot). New `ConnectionLostOverlay` (id `connection-lost-overlay`, button `reconnect-retry`, pointer-transparent backdrop per "must not block ESC menu", calls `clientRef.current?.retryNow()`); status line shows "· reconnecting…" / "· connection lost".

**Tests written:**
- `app/src/server/shard/shard.test.ts` — new describe "SystemShard reconnect and idle continuation (TASK-17)": idle-coast exact-vs-`integrateShip` reference, reconnect = same entity / no duplicate / un-idle, zombie conn (inputs dropped w/ debug log, late leave ignored, real close works).

## Working tree
- Modified (my work, listed above): 12 files under `app/src/`.
- **NOT my changes — do not commit with the task work, leave alone:** `opencode.json`, `ralph.config.json`, `ralph/package-lock.json`, root `package.json` + `package-lock.json` (untracked) — harness/ralph-loop files.
- Build state: `npx tsc --noEmit` in `app/` PASSES clean (ran at handoff time). No unit/integration tests have been run.
- `tasks.json` still `passes: false` (correct — task not done).

## Next steps
1. `cd app && npx tsc --noEmit` — fix any type errors (first run never happened).
2. Write **step 3: WS integration test** — planned file `app/src/server/galaxy/reconnect.ws.test.ts`, modeled on `lifecycle.test.ts` (same beforeAll: temp sqlite db, `createGalaxyRouter({ repo, galaxySeed, shipSwapBus, now: fakeNow })`, `createRouterGateway`, `attachWebSocket` WITH `onGameMessage` routing input like `index.ts`: `shard.enqueueInput(conn.playerId, payload as InputPayload, conn)`). Use 3 distinct systems from `generateStars(seed)` star indexes 0/1/2. Planned cases:
   - (a) mid-flight drop: player A + peer B join; A sends thrust inputs seq 1..5 then zero-input seq 6; wait ack 6; A closes; assert B gets presence leave; wait `shard.connections.size === 0`; capture authoritative `entity.ship.pos/vel` (`pStop`/`vStop`); sleep 2 s; assert entity `idle === true` and moved >1 u; A reconnects (same token) → enter snapshot: exactly 1 entity for A, total count unchanged (no duplicates); **continuity: `dist(snapshotPos, pStop + vStop·Δt) < 1 u`** — keep A's speed small (few thrust inputs; scout accel 40 u/s², so ~9 u/s) so the tick-quantization error (≤ |v|·0.05 ≈ 0.5 u) stays under budget; assert B gets presence join; assert a new input on the new conn works (entity `idle === false`).
   - (b) zombie conn: two LIVE conns, same token, same system (c1 then c2): c2's join supersedes c1 in the shard (`connections.size === 1`, exactly 1 entity); c2 sends zero-input seq 2 (wait ack 2); c1 (still open) sends thrust seq 9 → must be DROPPED (source guard) — assert ship velocity stays ~0 over ~1.5 s of snapshots (if the guard failed, seq 9 > lastSeq 2 would apply and accelerate); then `c1.close()` (late zombie close) → `connections.size` still 1, entity not idle; `c2.close()` → 0.
   - (c) reap-and-rejoin with FAKE clock: dedicated system; A joins, flies ~1 s, closes; advance `fakeNow` by `REAP_GRACE_MS + 1000` and call `router.reapEmpty()` (do NOT start the reaper interval); assert system gone; rejoin → new shard (generation bumped), read the flushed DB row via `repo.getShipByOwner`, assert rejoin snapshot pos is within `|v|·1.5 + 1` u of the row position and far from the dock (no reset), 1 entity.
   - Put case (c) LAST (it advances the shared fake clock; other systems get reaped by the same `reapEmpty()` call — assert `reaped >= 1`, not `=== 1`). Set per-test timeouts (~20-30 s; vitest default is 5 s).
3. Client unit tests still to write (planned, not written): `app/src/client/net/session.test.ts` with a scripted fake WebSocket (factory returning objects with `onopen/onmessage/onclose/onerror/readyState/send/close`; server-side: answer `join_system` with queued `enter_system` snapshots, `failNext` counter for refused opens, `drop(code)` for server-side closes; use `vi.useFakeTimers()` — Date.now is faked so the 30 s 'lost' window is reachable in one `advanceTimersByTime`). Cases: auto-retry at 1 s re-joins same system (`onSnapshot(_, true)`), backoff 1/2/4/5 s with cap, 'lost' after giveUpMs, `retryNow()` immediate dial, deliberate `close()` never retries, initial-join failure never auto-retries, error-frame during autoJoin drops the socket and retries, `send()` is a no-op while down. Plus small additions to `chat.test.ts` (`mergeSnapshot`: appends only newer ts, ring cap, no-op no-emit) and `presence.test.ts` (`reconnected()` toast, no change emit).
4. Run `npm run test` (watch: the tick-loop change makes owner-less ships integrate — check no existing test assumed frozen-after-leave; `shard.ws.test.ts`/`lifecycle.test.ts`/`crash-restart.test.ts` were reviewed and should be fine).
5. `npx eslint --fix` + `prettier --write` on changed files; `npx tsc --noEmit`.
6. Playwright smoke (UI changed: overlay + toast + status line): `npm run dev` in `app/` (background), page load via :3000, screenshot → `.agent/screenshots/TASK-17-1.png`. Optional deeper live check: with the page joined, kill only the tsx API server (port 3001) and restart it — the client auto-reconnects and shows the "reconnected" toast (backoff ≤ 5 s). Screenshot of the 'lost' overlay needs 30 s of downtime — optional.
7. Bookkeeping: set `passes: true` in `.agent/tasks.json` for TASK-17, log to `.agent/logs/LOG.md` (newest on top), update `.agent/STRUCTURE.md` (session.ts description changes; no new dirs), conventional commit (e.g. `feat(net): reconnect + full state resync without world reset (TASK-17)`), kill the dev server, output `<promise>TASK-17:DONE</promise>`.

## Dead ends
- `enquequeInput` edit failed once with a 3-space indent mismatch in `shard.ts` (method is 2-space indented) — fixed.
- `session.ts` rewrite contained one typo (`joinReject: ((err: Error) => void) => null`) — fixed; first `tsc` run then passed clean.
- No tests were ever executed this session — do not trust that anything currently passes.
- Design note: spec step 2 says backoff "up to 30 s" but the technical note says "capped at 5 s" — resolved as: per-attempt delay capped at 5 s (1,2,4,5,5…), 30 s = patience window before the 'Connection lost' overlay; retries continue in the background regardless.

## How to verify
- `cd app && npx tsc --noEmit` (typecheck)
- `cd app && npm run test` (vitest; expect new shard tests + the still-missing integration tests per Next steps)
- `cd app && npm run lint`
- Live: `cd app && npm run dev` → join a system at :3000, kill/restart the :3001 tsx process → "reconnected" toast + no UI reset; entity continuity and no-duplicate assertions are in the WS integration test (step 3 of the spec, not yet written).
