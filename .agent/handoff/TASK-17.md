# Handoff — TASK-17: Reconnect and full state resync

## Status
Implementation AND all tests (server unit, WS integration, client unit, Playwright e2e) are written and passing; full `npm run test` is green (56 files / 532 tests). **Only bookkeeping remains** (tasks.json, LOG.md, STRUCTURE.md, final commit) — the task is ~95% done.

## Done

**Previous session (already committed in `ff96adb` `wip(TASK-17): ...`):**
All of step 1 + step 2 — server idle continuation + stale-conn guards (shard.ts tick iterates playerEntities; registerConnection supersedes zombie conns; unregister/leave/enqueueInput source guards; adoptEntity un-idles), router/gateway/ws.ts `source: conn` plumbing, index.ts input routing with conn, and the client (session.ts rewrite: lazy dial, ConnectionState, 1 s backoff capped 5 s, 30 s 'lost' window, retryNow, onSnapshot(snapshot, reconnect); chat.ts mergeSnapshot; presence.ts reconnected toast; main.tsx ConnectionLostOverlay `#connection-lost-overlay` + `#reconnect-retry` + status-line suffixes), plus shard.test.ts reconnect describe.

**This session (uncommitted, in working tree):**
- `app/src/server/galaxy/reconnect.ws.test.ts` (NEW, ~300 lines) — live-ws integration, 3 tests, ALL PASSING:
  - (a) mid-flight drop: thrust 5 ticks (~10 u/s), zero-input ack 6, close → peer gets presence leave, ship goes `idle === true` after 2 s and moved > 1 u, reconnect snapshot has exactly 1 entity for A / total count unchanged, continuity `dist(snapPos, pStop + vStop·Δt) < 1 u`, peer gets presence join, new conn acks.
  - (b) zombie conn: c2 same-token join supersedes c1 (connections.size 1, 1 entity); c1's thrust seq 9 DROPPED (vel stays < 0.5 after 1.5 s); c1's late close leaves conn + non-idle entity intact; c2 close empties + idles.
  - (c) reap-and-rejoin with fake clock: fly ~1 s, close, `fakeNow += REAP_GRACE_MS + 1000`, `router.reapEmpty()` → `reaped >= 1`, system gone, DB row `state === 'flying'`, rejoin → generation 2, snapshot pos within `|v|·1.5 + 1` of row, > 10 u from dock.
  - beforeAll mirrors lifecycle.test.ts BUT with `now: () => fakeNow` on the router AND `onGameMessage` input routing (`shard.enqueueInput(conn.playerId, payload as InputPayload, conn)`) — same as index.ts. Systems = star indexes 0/1/2.
- `app/src/client/net/session.test.ts` (NEW, 7 tests, PASSING) — scripted fake WebSocket (wsFactory) + `vi.useFakeTimers()`, injected `retry: { baseMs: 10, capMs: 40, giveUpMs: 300 }`. Cases: retry at base + resync `onSnapshot(_, true)`; backoff 10/20/40/cap + 'lost' via a fail-loop (state only flips to 'lost' on a retry STEP after the window); refused rejoin (error frame during autoJoin → session closes own socket → next backoff dial); deliberate close never retries; initial connect failure = caller error path, no retry; send() no-op while down; hello+auth+join_system on every dial.
- `app/src/client/net/chat.test.ts` — +2 tests: mergeSnapshot appends only newer-than-tail; ring cap + no-op/no-emit when nothing new.
- `app/src/client/net/presence.test.ts` — +1 test: `reconnected()` fires 'reconnected' toast, zero change emits, list untouched.
- `app/tests/reconnect.spec.ts` (NEW, Playwright, PASSING ~39 s) — init-script WebSocket proxy: `__dropCurrent()` closes the game socket (URL filter `includes('/ws')` — MUST NOT touch vite HMR), `__wsBlock = true` makes game dials return a STUB that fails with onerror+onclose(1006) after 20 ms. Flow: claim+join → send chat 'staying put' → drop → status `<p>` (the "server ok — seed …" line, NOT #sys-id) shows "reconnecting" → 30 s → `#connection-lost-overlay` + `#reconnect-retry` visible (screenshot TASK-17-1.png) → unblock → auto-resync ≤ 5 s → toast 'reconnected', chat 'staying put' preserved, claim form hidden, overlay hidden (screenshot TASK-17-2.png), zero console errors. `test.setTimeout(120_000)`.
- Screenshots: `.agent/screenshots/TASK-17-1.png` (overlay), `TASK-17-2.png` (recovered) — both exist.
- `src/client/main.tsx` + `reconnect.ws.test.ts` were prettier-reformatted this session (whitespace only for main.tsx).

## Working tree
- **Uncommitted (all mine):** `app/src/server/galaxy/reconnect.ws.test.ts`, `app/src/client/net/session.test.ts`, `app/src/client/net/chat.test.ts`, `app/src/client/net/presence.test.ts`, `app/tests/reconnect.spec.ts`, `app/src/client/main.tsx` (prettier whitespace), `.agent/screenshots/TASK-17-1.png` + `TASK-17-2.png`.
- **NOT mine — do not commit:** `opencode.json`, `ralph.config.json`, `ralph/package-lock.json`, root `package.json` + `package-lock.json` (untracked, harness/ralph-loop files).
- `app/test-results/` is playwright scratch — gitignored, safe to `rm -rf`.
- Build state: `npx tsc --noEmit` clean, `eslint --fix` clean, full `npm run test` → **56 files / 532 tests ALL PASS** (ran at handoff time). Playwright: `tests/reconnect.spec.ts` passes; the OTHER e2e specs (scaffold/presence/chat/session-log-leak/validation-fuzz) were NOT re-run this session (they passed under TASK-16).
- Dev server was KILLED at handoff (was `npm run dev` in `app/`).
- `tasks.json` still `passes: false` (correct — bookkeeping not done).

## Next steps
1. Optional: `cd app && npm run dev` (background) + `npx playwright test` (full e2e suite) — expect all green; kill dev server after.
2. Bookkeeping:
   - `.agent/tasks.json` → TASK-17 `passes: true` (all step.pass → true too).
   - `.agent/logs/LOG.md` → prepend a "### 2026-09-30 — TASK-17: Reconnect and full state resync" entry (style: mirror the TASK-16 entry above it; cover server idle-continuation + stale-conn guards, client session rewrite, all the tests listed above, screenshot paths, "Verified:" line with the 56/532 numbers).
   - `.agent/STRUCTURE.md` → update: line ~26 session.ts (TASK-17: lazy dial, ConnectionState, auto-retry 1 s→5 s cap, 30 s 'lost' + retryNow, onSnapshot(snapshot, reconnect)); line ~25 presence.ts (+ reconnected toast); line ~27 chat.ts (+ mergeSnapshot resync); line ~45 galaxy (tests) → add `reconnect.ws.test.ts (live ws: mid-flight drop/idle coast/no-duplicate/continuity < 1 u, zombie-conn guards, fake-clock reap-and-rejoin)`.
3. `rm .agent/handoff/TASK-17.md` IN THE SAME commit as the bookkeeping.
4. Conventional commit (e.g. `feat(net): reconnect + full state resync without world reset (TASK-17)`), excluding the harness files listed above.
5. Output `<promise>TASK-17:DONE</promise>` and stop.

## Dead ends
- **e2e: `ctx.setOffline(true)` does NOT sever an already-established WebSocket** in Chromium — session stayed 'connected', status line never changed.
- **e2e: killing a blocked retry dial 50 ms after construction did not work** — the local join handshake completes in ~10 ms, so the session kept resyncing→killing→resyncing (3 queued 'reconnected' toasts) and `downSince`/`lostReported` reset on every resync, so 'lost' never fired. Fix: while blocked, the proxy returns a STUB socket (plain object with readyState/onopen/onmessage/onclose/onerror/send/close) that fires onerror+onclose(1006) after 20 ms — no real connection can form.
- **e2e: closing ALL page sockets killed vite's HMR socket** (`ws://localhost:3000/?token=…` — note: game socket is `ws://localhost:3000/ws`) → vite's dev client reloaded the page and the test state was gone. Filter with `url.includes('/ws')`.
- **e2e: 'reconnecting'/'connection lost' render in the STATUS `<p>`** ("server ok — seed … · reconnecting…"), NOT in `#sys-id` (that shows "sys <id> · N aboard").
- **Integration (a): the shard never empties while peer B is in-system** — wait for `entity.idle === true` (after presence leave), not `shard.connections.size === 0`.
- **claim() helper type was missing `playerId`** (TS2339) — POST /api/callsigns DOES return it (`callsign, token, playerId, homeSystemId, shipId`); just widen the cast.
- Session test gotcha: the fake socket sends hello/auth/join only when its `onopen` handler fires — call the harness `open(i)` BEFORE inspecting `sent` frames.

## How to verify
- `cd app && npx tsc --noEmit` (clean at handoff)
- `cd app && npm run test` → 56 files / 532 tests (green at handoff; takes ~80 s)
- `cd app && npm run dev` (background) then `npx playwright test tests/reconnect.spec.ts` (~40 s, green at handoff)
- Bookkeeping check: `grep -n "passes" .agent/tasks.json | head` — TASK-17 should be flipped to true before the final commit.
