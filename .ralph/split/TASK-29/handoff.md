# Handoff: TASK-29

Written by Ralph: the agent ran out of time without leaving a complete handoff,
so this records what the loop could see.

## Status

Iteration 5 did not finish the task: Iteration exceeded its 45m budget.

## Done

Commits made during the iteration:

```
3d14686 wip(TASK-29): server pad state machine + VTOL assist + pad derivation + dev teleport routes; tsc clean, tests/client/e2e pending
```

## Working tree

Clean.

## Next steps

Read the agent's last messages below and any uncommitted changes, decide what is worth
keeping, then continue the task.

## Dead ends

Not recorded.

## How to verify

Follow the task spec.

## The agent's last messages

> Now let me check the router, routes registration, and env for wiring a dev teleport endpoint.
>
>
> Let me probe the seeded galaxy to find a good e2e landing target and check pad-area flatness.
>
>
> I have the full picture now. Let me check the remaining wiring details: client session send, route auth patterns.
>
>
> Time to implement. First, the core shared pad module.
>
>
> 12 minutes left — moving fast, committing checkpoints as I go.
>
>
> Now wire the shard:
>
>
> Now the dev test endpoint (for the e2e teleport-assist):
>
>
> Important discovery: since the planet's atmospheric anchor is at `(i+1)*10000 m` but the chunk (0,0) pad is near the origin, the pad must be placed at `anchor + seeded offset` so that it actually ends up within the planet's atmosphere. Fixing `padsForSystem`:
>
>
> Handoff complete.
>
> **State of TASK-29** (committed as `wip(TASK-29)` at `3d14686`, working tree clean, `tsc --noEmit` green):
>
> - **Done:** full server side — `app/src/shared/world/pads.ts` (pad derivation + pure detection/hysteresis/VTOL-assist math), shard integration (`SimEntity.padId`, per-tick pad state machine, VTOL drift damping, flat-pad terrain override, `teleportForTesting`, wire `padId` in `entity_update`, persist round-trip), and dev-only REST routes (`/api/dev/pad-target`, `/api/dev/teleport`) for the e2e teleport-assist.
> - **Not done:** all tests (unit + sim convergence + e2e), client work (pad rings, `#docked-indicator`, `__PADS__` debug hook), tasks.json/LOG/STRUCTURE updates.
> - **Key findings recorded in the handoff** (`.ralph/handoff/TASK-29.md`): pads must be placed at `planetAnchor + seeded offset` (chunk (0,0) coords sit ~10 km outside the planet's atmosphere), the atmosphere regime has no main thrust (approach = initial momentum + drag + final VTOL braking; VTOL-only can't produce net climb, so takeoff tests inject vertical velocity), and the ×0.5/tick assist kills all momentum in ~3 m so it must only be held in the final phase.
>
> No background processes running. Stopping here.

## The agent's incomplete handoff

> # Handoff: TASK-29
>
> Spec: `.ralph/tasks/TASK-29.json` (landing pads: detection, VTOL assist, docked state).
>
> ## Status
>
> Server-side implementation is complete and typechecks (`npx tsc --noEmit` in `app/` → clean). NO tests have been written or run yet for this task, and none of the client work (pad rings, DOCKED indicator, debug hook, e2e) exists yet. Pick up at "write tests" below.
>
> ## Done (all uncommitted-then-committed as wip in this commit, all in `app/`)
>
> - `src/shared/world/pads.ts` (NEW, step 1): `padsForSystem(galaxySeed, system)` — one pad per landable planet, cached per (seed, systemId). Pad layout (id + local xz offset) comes from the planet's chunk (0,0) seeded pad (TASK-5 data); **world position = `planetAnchor(index)` + local offset** (critical: the anchor is at `(i+1)*10000 m`, chunk (0,0) is at the origin — without the anchor offset a pad is ~10 km outside its planet's atmosphere and can never reach the surface regime). Pad height = terrain cell height at that world position. Also pure helpers + constants: `resolvePadTarget` (20 m acquire / 25 m release hysteresis, nearest, tie-break padId, ≤1 pad), `satisfiesDock` (≤20 m + surface regime + |vel.y|<2 + |alt−padY|≤1), `vtolAssistActive` (up held + speed<50 + ≤100 m), `applyVtolAssist` (vel.x/z ×0.5), `padSurfaceHeight` (flat 20 m disc at pad height, raised-cosine blend to 30 m). Constants: PAD_RADIUS_M=20, PAD_RELEASE_RADIUS_M=25, PAD_FLAT_BLEND_OUTER_M=30, DOCK_VERTICAL_SPEED_MAX_M_S=2, DOCK_ALTITUDE_TOLERANCE_M=1, VTOL_ASSIST_RANGE_M=100, VTOL_ASSIST_SPEED_MAX_M_S=50, VTOL_ASSIST_DAMPING=0.5.
> - `src/shared/protocol/schemas.ts`: `entityStateSchema` gained `padId: z.string().min(1).optional()`.
> - `src/server/shard/types.ts`: `SimEntity.padId?: string`.
> - `src/server/shard/shard.ts` (steps 2–3 server): constructor derives pads into `planetPads` Map; **both** heightAt seams (regime-machine closure + `resolveRegimeCtx` options) wrap TerrainContext with `padSurfaceHeight` so the pad disc is flat for physics AND regime; tick now computes `shipInput` once, integrates, then `updatePadState(entity, shipInput.up)`: resolve target → dock/undock (emits `pad-dock`/`pad-undock` events, debug logs) → VTOL assist on `entity.ship.vel`; NEW public `teleportForTesting(playerId, pos, vel?)` for the e2e teleport-assist; `entityToState`: regime 'docked' when `e.docked || e.ship.onPad || e.padId`, and `state.padId` set; `entityFromShipRow`: pad-docked rows (`state==='docked' && onPad`) keep their saved position (not the space dock) and restore `padId`.
> - `src/server/shard/persist.ts`: flush marks pad-docked ships 'docked' and stores `onPad: e.padId ?? e.ship.onPad ?? null` (load path restores from that column).
> - `src/server/routes/dev.ts` (NEW) + `routes/index.ts`: dev-only (NODE_ENV !== 'production', needs galaxyRouter) `GET /api/dev/pad-target` (first star-order system with a landable atmospheric planet + its pad) and `POST /api/dev/teleport` {x,y,z} (auth Bearer; moves the caller's ship via `shard.
