# Handoff: TASK-40

Written by Ralph: the agent ran out of time without finishing, so this records
exactly where the work stands for the next session (which has no memory of this one).

## Status

The server side of the dock-sell feature is COMPLETE and tested (shared math, terminal
geometry, shard handler, WS + REST endpoint, schema), and all three new unit/WS test files
are green. The remaining work is: the browser e2e test (sell.spec.ts), a full-suite +
lint/prettier pass, and the bookkeeping (tasks.json / LOG.md / STRUCTURE.md / delete this
handoff). The e2e is the only substantive piece left.

## Done

- **Shared modules (new):**
  - `app/src/shared/sell.ts` — `sellUnitPrice(resourceId: string)` (single price read site,
    throws on unknown id; widened from `ResourceId` to `string` so the error path is real),
    `sellFrom(hold, inv, resourceId, amount, source)` (pure atomic sell step, returns
    NEW stacks + earned; denial codes `invalid-resource|invalid-amount|insufficient`),
    `sellableTotal`, `SellSource`, `SellErrorCode`, `SellResult`.
  - `app/src/shared/world/terminals.ts` — `terminalsFor`, `terminalPosFor`, `terminalIdFor`,
    `withinTerminalRange`, `terminalDistanceM`, `TERMINAL_RANGE_M = 10`,
    `TERMINAL_EDGE_OFFSET_M = 2`. One terminal per pad, derived at the pad edge
    (pad.radius − 2 m), flat pad plane (y = pad height).
  - Tests: `app/src/shared/sell.test.ts` (11), `app/src/shared/world/terminals.test.ts` (9).
    Both green.

- **Server (modified, typecheck green):**
  - `app/src/server/db/repo.ts` — added `updateShipCargo(shipId, stacks)` to the Repository
    interface + impl (single UPDATE of ships.cargo JSON, for the sell transaction).
  - `app/src/server/shard/shard.ts`:
    - imports terminals + sell; the repo type now includes
      `withTransaction | addCredits | updatePlayerInventory | updateShipCargo` (Partial).
    - constructor spawns one static `kind:'terminal'` entity per pad via
      `spawnTerminalEntity` (from `terminalsFor`).
    - `handleSell(playerId, {resourceId, amount, source}, source?)` — the single handler
      behind BOTH the WS 'sell' frame and POST /api/ships/sell. Validation order: own ship →
      valid resource → positive-integer amount → `!ship.docked && !ship.padId` → `not-docked`;
      for `source:'inv'` the character must be within `TERMINAL_RANGE_M` of a terminal else
      `not-at-station`; then `sellFrom` (`insufficient` if short). Success commits the stack
      decrement + `addCredits` in ONE `repo.withTransaction` (rollback on throw → `sell-failed`),
      applies in-memory, fires a `sold` event, sends the `sell` RESULT frame.
    - `nearestTerminalDistance(pos)`, `sendSellResult(...)` (validates the result frame
      against the wire schema before sending).
    - `sendUiOpen(...)` now carries the initial `hold` + `inventory` in the 'ui-open' dock
      payload (the `payload` is a free-form `z.record`, no schema change) — so the dock panel
      opens fully populated (the panel is at the pad edge, far beyond cargo_open's 5 m reach).
    - `teleportCharacterForTesting(playerId, pos)` — hard-sets the on-foot `char:<id>` entity
      (dev/test hook for the e2e).
  - `app/src/server/shards.ts` — `routeGameMessage` routes the WS `sell` message to
    `shard.handleSell`.
  - `app/src/server/routes/ships.ts` — `POST /api/ships/sell` (auth → body parse →
    `isResourceId` 400 → 404 no-ship → 409 not-in-system → `shard.handleSell` → maps codes:
    invalid-resource/invalid-amount 400, not-docked/not-at-station 409, insufficient 422,
    unknown-ship 404, else 500; success → `{sold, earned, newBalance}`).
  - `app/src/shared/protocol/schemas.ts` — `sell` is now a UNION of the request form
    `{resourceId, amount, source}` and the result form
    `{resourceId, sold, earned, balance, hold, inventory}`. `schemas.test.ts` updated to match.
  - `app/src/server/routes/dev.ts` — two NEW dev-only e2e endpoints:
    `GET /api/dev/terminal-target` (returns the terminal's world pos for the pad target) and
    `POST /api/dev/teleport-char` (teleports the on-foot character to a given xyz).

- **Client (new + modified):**
  - `app/src/client/state/credits.ts` — credits-counter store (`setCredits/credits/
    creditsSubscribe/__resetCredits`).
  - `app/src/client/state/dock.ts` — dock-panel store (`openDockPanel(terminalId, hold,
    inventory)`, `applySellResult(balance, hold, inventory)`, `closeDockPanel`, subscribe,
    `DockHoldView`/`DockInventoryView`).
  - `app/src/client/state/credit-float.ts` — transient "+N cr" float store.
  - `app/src/client/ui/dock-panel.tsx` — `<DockPanel onSell>` : tabs SELL (live) / SHIPS /
    REPAIR (TASK-53 stubs). Sell tab lists sellable resources (catalog order) with base price,
    `hold N · inv M`, and per-source buttons with aria-labels
    `sell 1 <res> hold|inv` and `sell all <res> hold|inv`. `#dock-panel`, `#dock-balance`.
  - `app/src/client/ui/credits-hud.tsx` — `<CreditsCounter>` (`#credits-counter`, renders
    `{value} cr`, hidden until a balance lands) and `<CreditFloatLayer>` ("+N cr" rise-and-fade).
  - `app/src/client/main.tsx` — imports the new modules; `ui-open` handler opens the dock
    panel (reads hold+inventory from the payload); a `sell` handler applies the result frame
    (`applySellResult` + `setCredits` + `pushCreditFloat`); a boot effect fetches
    `GET /api/players/me` to seed the counter; renders `<DockPanel onSend=...>`,
    `<CreditsCounter>`, `<CreditFloatLayer>`.

- **Server tests (new, all green):**
  - `app/src/server/shard/shard.sell.test.ts` (7) — station check (docked hold sell OK;
    undocked → not-docked; on-foot inv far from terminal → not-at-station; at terminal → OK),
    validation ladder, atomicity ROLLBACK (addCredits throws → stack not applied, no credits),
    `sold` event.
  - `app/src/server/galaxy/sell.ws.test.ts` (6) — the FULL LOOP (mine 10 iron fake → load hold
    → sell → 550) over BOTH WS 'sell' and REST /api/ships/sell (same handler), plus
    not-docked / not-at-station / insufficient (WS+REST 422) / unknown-resource (400) /
    invalid body (400).

## Working tree

NOT committed. Everything above is in the working tree (modified + untracked files listed by
`git status`). It BUILDS: `npx tsc --noEmit` in `app/` is green (exit 0). The three new
server/shared test files pass when run individually (shared: 20, shard.sell: 7, sell.ws: 6).
The FULL project suite (`npm run test`) has NOT been re-run since these changes — run it
before committing the final task. `eslint`/`prettier` have NOT been run on the new files.

The previous iteration's old handoff (this file) is overwritten by this one.

## Next steps

In order:

1. **Write the e2e** `app/tests/e2e/sell.spec.ts` — mirror `tests/e2e/cargo.spec.ts` exactly
   (same `import { expect, test } from './fixtures'`, `collectErrors`/`uniqueCallsign` from
   `./helpers`, `RawWsClient` from `./raw-ws`; `test('...', async ({ browser, e2eServer }) =>
   { const { baseURL, apiPort } = e2eServer; ... })`). Flow:
   - (server-side raw REST+WS) claim → `GET /api/dev/pad-target` + `GET /api/dev/terminal-target`
     → join/warp to pad system over `RawWsClient` (ws://127.0.0.1:${apiPort}/ws) →
     `POST /api/dev/teleport` to pad.pos (docks the ship) → `POST /api/dev/give` 5 iron →
     close the raw client.
   - (browser) new context, `localStorage.setItem('drift.session.v1', ...session)`,
     `page.goto(`${baseURL}/?sys=${padTarget.systemId}`)`; wait `#ship-hud-cargo` visible
     (in-ship); `page.keyboard.press('e')` (disembark); wait `#weight-bar` text `/5\/40u/`
     (on-foot, 5 iron).
   - (server-side) `POST /api/dev/teleport-char` to a point ~1.5 m from the terminal
     (e.g. `{x: term.pos.x + 1.5, y: term.pos.y, z: term.pos.z}`) with the Bearer token —
     parks the on-foot character at the terminal (the disembark spawn is ~15.5 m from it, past
     the 3 m interact AND 10 m sell ranges, so the walk must be teleported).
   - (browser) spin to face the terminal: `page.keyboard.down('d')`,
     `await expect(page.locator('#interact-prompt')).toContainText('[E] Dock terminal',
     { timeout: 30_000 })`, `page.keyboard.up('d')`; `page.keyboard.press('e')` → `#dock-panel`
     opens.
   - (browser) assert `#credits-counter` shows `500 cr` (seeded from /api/players/me);
     click `page.locator('#dock-panel button[aria-label="sell all iron inv"]')`; assert
     `#credits-counter` updates to `525 cr` (500 + 5×5); `page.screenshot` to
     `.ralph/screenshots/TASK-40-1.png`; `assertClean()`.
   - Note the local CharacterPredictor reconciles to the server teleport on the next 10 Hz
     snapshot (~100 ms), so the spin must start only after that — the 30 s prompt timeout
     absorbs it. If the spin direction misses, also try holding 'a'.

2. `cd app && npx eslint --fix <new files> && npx prettier --write <new files>`.
3. `cd app && npx tsc --noEmit` (already green) and `npm run test` (full suite — must be
   green; fix any unrelated break).
4. Run the e2e: `cd app && npm run test:e2e sell.spec.ts` (boots the real dev server itself via
   the fixture — do NOT also run `npm run dev`; no background dev server should be left up).
   Screenshot must show the dock panel + updated counter.
5. Bookkeeping: set all 4 `pass: true` in `.ralph/tasks/TASK-40.json` and `"passes": true` for
   TASK-40 in `.ralph/tasks.json`; add a `.ralph/logs/LOG.md` entry at the top (date, summary,
   screenshot path) and bump 'Tasks Completed'; update `.ralph/STRUCTURE.md` if needed (new
   dirs: none beyond existing app/src/shared, app/src/client/state, app/src/client/ui,
   app/src/server — likely no change); DELETE `.ralph/handoff/TASK-40.md`; Conventional-Commit;
   output `<promise>TASK-40:DONE</promise>`.

## Dead ends

- `sellUnitPrice` was originally typed `(resourceId: ResourceId)`, which made its
  "throws on unknown id" branch unreachable from typed code and broke the unit test that
  passes `'plutonium'`. Fixed by widening the param to `string` and guarding with
  `isResourceId`.
- The `ui-open` dock frame only carried `{terminalId}` initially, and the dock panel sits at
  the pad edge (PAD_RADIUS_M = 20, so ~18 m from the docked ship) — beyond cargo_open's 5 m
  reach, so the panel could not reuse a 'cargo' frame for its hold/inventory. Fixed by adding
  `hold` + `inventory` to the free-form `ui-open` payload (no schema change).
- `this.repo` in the shard types the sell transaction methods as `Partial` (optional), so the
  `typeof X !== 'function'` guard did NOT narrow inside the `withTransaction` closure
  (TS2722). Fixed with an in-branch `typeof` re-check + defensive throw.

## How to verify

- Unit/WS (already green, re-run to confirm): `cd app && npx vitest run src/shared/sell.test.ts
  src/shared/world/terminals.test.ts src/server/shard/shard.sell.test.ts src/server/galaxy/sell.ws.test.ts`
- Full suite: `cd app && npm run test` (must be green; the handoff notes flaky scale/perf
  tests may predate this change — if they fail, check they also fail on the parent commit).
- Typecheck: `cd app && npx tsc --noEmit`.
- e2e: `cd app && npm run test:e2e sell.spec.ts` (the fixture boots its own server).
