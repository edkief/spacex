# TASK-34 handoff (iteration 18, cut at deadline)

Status: IMPLEMENTED + tsc-clean + unit tests green, committed as 5c20895.
NOT yet `passes: true` — remaining work below.

## Done (committed 5c20895)
- `src/shared/inventory.ts` (NEW): catalog (iron/copper/rare-earth/crystal = 1/1/2/3 w),
  `INVENTORY_MAX_WEIGHT=40`, pure math `pickupInto` (partial at boundary), `dropFrom`,
  `sanitizeInventory`, `listStacks`, `toPlayerInventory`. Tests: `inventory.test.ts` (7 pass).
- Protocol (`schemas.ts`): ENTITY_KINDS += 'groundItem'; entityState += `resourceId?` +
  `inventory?` {stacks, weightUsed}; new inbound message `drop` {resourceId, amount}.
  `shared/interaction.ts`: INTERACTABLE_KINDS += 'groundItem'; InteractableTarget +=
  resourceId/quantity.
- Shard (`shard.ts`): `handlePickup` (on-foot → ground item → 3 m → partial pickupInto,
  {taken, remaining}, 'inventory-full' denial, despawn at zero, 'pickup' event),
  `handleDrop` (resource/amount/ownership/on-foot validation, spawns `groundItem:<n>` at
  character pos, ttl = GROUND_ITEM_TTL_MS 300 s via the existing tick ttl sweep),
  `giveInventoryForTesting` (e2e hook), handleInteract 'groundItem' branch,
  entityToState carries `resourceId` + player `inventory`. Inventory loads on join
  (adoptEntity via repo.getPlayerInventory, optional in the repo Pick) + loadShips
  (restart rehydration).
- Persistence: migration `000002_player_inventory.sql` (players.inventory TEXT '{}'),
  drizzle schema (sqlite + pg) + PlayerRow.inventory, repo `getPlayerInventory` /
  `updatePlayerInventory` (JSON, corrupt → {}), persist.ts flushShips writes inventories
  in the same tx (FlushSummary.inventories).
- Client: registry 'groundItem' entry ('[E] Take iron x3'), interactableTargetsFrom
  carries resourceId/quantity; `state/inventory.ts` store (emit-on-change, canonicalJson);
  `ui/weight-bar.tsx` (#weight-bar, 120 px, amber ≥70% / red at cap, hover = stack list,
  pure weightBarColor/weightBarHoverLines); main.tsx wires the store from self
  entity_update, snapshot reset, mounts <WeightBar/>, Q key drops 1 of first owned
  resource (server re-validates).
- `npx tsc --noEmit` clean. `vitest run src/shared/inventory.test.ts` → 7/7.

## REMAINING (next iteration, in order)
1. ESLint/Prettier on all touched files (not run before cutoff):
   inventory.ts/.test.ts, schemas.ts, interaction.ts (shared+client), types.ts,
   shard.ts, persist.ts, schema.ts, repo.ts, shards.ts, weight-bar.tsx,
   state/inventory.ts, main.tsx, session.test.ts (added `inventory: '{}'` to PLAYER).
2. Sim integration test `src/server/shard/shard.inventory.test.ts` (shard.interact.test.ts
   conventions; stub repo needs `getPlayerInventory: async () => ({})` if adopted-entity
   load is exercised): give → drop → groundItem entity + snapshot quantity/resourceId;
   partial pickup at 40/40 boundary (take what fits, remainder stays); despawn at zero;
   ttl expiry (run ~groundItemTtlTicks steps or inject dtMs:60 to shorten); denials
   (wrong-regime in ship, not-owned, invalid-resource, out-of-range >3 m); persistence:
   flush → fresh shard loadShips/adoptEntity restores stacks (in-memory sqlite repo).
3. WS test `src/server/galaxy/inventory.ws.test.ts` (interact.ws.test.ts pattern): two
   clients, one drops, BOTH see the groundItem in the same snapshot; second client
   picks up (partial) → both see quantity change + inventory field.
4. Optional dev route (nice for e2e): POST /api/dev/give {resourceId, amount} in
   routes/dev.ts → shard.giveInventoryForTesting.
5. Playwright smoke (UI piece): follow interact.spec.ts (server-side disembark +
   /api/dev/give + drop via 'drop' frame or Q key) → #weight-bar visible with fill,
   console clean; screenshot `.ralph/screenshots/TASK-34-1.png`.
6. Full `npm run test` green + `npm run test:e2e` (if spec added); tasks.json
   passes:true + step flags; LOG.md entry; STRUCTURE.md: add shared/inventory.ts,
   client/state/inventory.ts, client/ui/weight-bar.tsx, migration 000002, shard notes;
   commit (rename off WIP).

## Gotchas
- SimEntity.kind union now includes 'groundItem' (types.ts) — the wire ENTITY_KINDS
  already matches.
- handleInteract returns InteractOutcome ('ok') for ground items; {taken, remaining}
  rides the 'pickup' event (payload now includes resource/taken — extend any listener
  that typed it).
- entity.inventory is UNDEFINED until first pickup/load — entityToState omits the field
  then (client bar hidden), and persist skips undefined inventories (never clobbers rows).
- PlayerRow gained a required `inventory` string field — grep for hand-built PlayerRow
  literals in tests if tsc complains elsewhere (session.test.ts was the only one found).
