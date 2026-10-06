# Handoff: TASK-76

Written by Ralph: the agent ran out of time without leaving a complete handoff,
so this records what the loop could see.

## Status

Iteration 2 did not finish the task: Iteration exceeded its 45m budget.

## Done

Commits made during the iteration:

```
daec652 wip(TASK-76): e2e repro spec for off-centre atmosphere blackout (not yet failing pre-fix; far-plane fix not applied)
c26f1df design: system/planets scale refactor tasks
```

## Working tree

Uncommitted changes when it stopped:

```
 M .ralph/screenshots/TASK-28.1-1.png
 M .ralph/screenshots/TASK-70-1.png
 M .ralph/screenshots/TASK-72-1.png
 M .ralph/screenshots/TASK-73-1.png
 M ralph.config.json
?? .ralph/screenshots/TASK-76-1.png
```

## Next steps

Read the agent's last messages below and any uncommitted changes, decide what is worth
keeping, then continue the task.

## Dead ends

Not recorded.

## How to verify

Follow the task spec.

## The agent's last messages

> able (pad sits at y≈162 here). I'll target an altitude relative to the pad:
>
>
> Test passes pre-fix (mean 56.8) — not reproducing. Let me examine the haze/density math to understand why:
>
>
> Let me check the teleport body schema (maybe it can set rotation) and the __SELF_SHIP__ probe hook:
>
>
> I need to check the e2e seed and compute the pad planet's haze to size the test properly:
>
>
> Let me look at the screenshot from that pre-fix passing run to see the actual view:
>
>
> The `__ATMO__` hook already uses far=5000 and reveals the terrain model. Let me examine the surface heightmap to find a precise off-centre point.
>
>
> The `__ATMO__` comments mention a `__CAMERA__` hook. Let me look at the debug hooks available.
>
>
> Let me look at the screenshot from my earlier (passing) pre-fix run to understand the actual view geometry.
>
>
> Let me check the ship's rotation controls — if I can yaw the ship to face the anchor, the ship-based e2e becomes robust.
>
>
> The probe exposes `rot` — "TASK-74 e2e aims off the nose." There's likely an existing aim pattern:
>
>
> The probe exposes `rot`. Before over-engineering, let me empirically test the task's exact teleport (y:60 absolute) to see the actual regime and top-band values. Let me rewrite the teleport section:
>
>
> Let me understand how yaw/pitch input rotates the ship, to build a reliable aim loop.
>
>
> Let me empirically measure the ship's facing vs the anchor direction with a quick debug spec, to know if aiming is needed at all.
>
>
> The ralph.config.json change is pre-existing, not mine. Let me clean up the debug code in the e2e spec.
>
>
> Now let me write the handoff. First verify no background processes are running.
>
>
> Now I'll write the handoff.
>
>
> Let me verify the e2e spec has no leftover debug artifacts.
>
>
> Now commit the work.
>
>
> Committed. No background processes remain (the e2e fixture self-tears-down, and I killed any lingering dev servers).
>
> TASK-76 is handed off. Summary of where it stands:
>
> - **Step 3 (e2e) built and committed** — `app/tests/e2e/atmosphere-sky.spec.ts` resolves the pad via `/api/dev/pad-target`, warps if needed, taps the ship WS (`flightRegime`), teleports off-centre at pad-relative altitude, and asserts the top canvas band is not black.
> - **Steps 1, 2, 4 not done** — the far-plane fix (`CAMERA_FAR = 4000` in `WorldManager.ts:387`) is not applied, no unit test, no final verify.
> - **Key blocker documented:** the e2e currently PASSES pre-fix (top mean 56.8, hazy, not black), so it is not yet a failing repro. The most likely cause is that the chase camera looks along the ship's forward, which after the dev-teleport isn't aimed at the clipped far wall of the dome. Aiming the nose at the anchor (yaw keys `d`/`a`, using `__SELF_SHIP__.probe().rot`) is the untried-but-most-promising fix.
>
> The handoff is at `.ralph/handoff/TASK-76.md` with ordered next steps, dead ends, and exact verify commands. I did not set `passes: true` and did not commit the pre-existing dirty screenshots or the unrelated `ralph.config.json` change.

## The agent's incomplete handoff

> # TASK-76 handoff — Blackout fix (atmosphere): camera far plane must contain the whole dome
>
> Spec: `.ralph/tasks/TASK-76.json` (4 steps). Priority bug: black 3D view inside
> atmosphere because the game camera far plane (1000 u) clips the far wall of the
> atmosphere dome (radius 1010 u, centred on the planet anchor).
>
> ## Status
> Only STEP 3 (the e2e) has been built and is committed. STEPS 1, 2, 4 are NOT done:
> the far-plane fix is not applied, the unit test is not written, and the e2e has
> NOT yet been shown to fail pre-fix (it currently PASSES pre-fix — see Dead ends).
>
> ## Done
> - `app/tests/e2e/atmosphere-sky.spec.ts` (new, 236 lines): full e2e per step 3.
>   Claims a ship, resolves a landable atmospheric pad via `GET /api/dev/pad-target`
>   (home system first, then unscoped, warps with `keyboardWarp` if off-home), taps
>   the ship's WebSocket via an init-script (`addInitScript(installShipTap, callsign)`)
>   reading `flightRegime` (NOT `regime` — ship-level regime is 'sublight'),
>   presses W to undock, teleports off-centre, polls until `__SELF_SHIP__.probe().pos`
>   is within 50 u AND `flightRegime === 'atmosphere'`, then asserts the TOP band
>   (`{x0:0,y0:0,x1:1,y1:0.3}`) mean luminance > 5 via `canvasRegionStats`, and
>   screenshots `.ralph/screenshots/TASK-76-1.png`.
>   - It tries offsets `[600,450,300,150]` u off the pad and altitude = `pad.y + 200`
>     (pad-relative, see Dead ends re: terrain relief).
>   - It RAN GREEN pre-fix: `[TASK-76] off-centre 600 u ... regime=atmosphere: top band
>     mean=56.8 bright=348` (1 passed, 17.4s). **This is NOT a failing repro.**
>
> ## Working tree
> - NOT committed yet: `app/tests/e2e/atmosphere-sky.spec.ts` (new) and
>   `.ralph/screenshots/TASK-76-1.png` (new). `ralph.config.json` is a pre-existing
>   unrelated dirty file (a `ui.token` line) — DO NOT commit it.
> - The 4 modified `.ralph/screenshots/TASK-28.1/70/72/73-1.png` are pre-existing
>   dirty files from prior tasks — DO NOT commit (spec note says so).
> - `app/src/client/world/WorldManager.ts` line 387 still reads
>   `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)` — the FIX IS NOT APPLIED.
> - Build: not re-verified after cleanup; the e2e spec compiles (it ran). No unit tests
>   were touched, so `npm run test` / `tsc` state is unchanged from before this session.
>
> ## Next steps (in order)
> 1. **Make the e2e actually reproduce the bug (the blocker).** Currently at +600 u /
>    pad-relative +200 u the top band is hazy (mean 56.8), not black — the dome's far
>    wall is evidently still inside the 1000 u far plane for this geometry, or the
>    chase-camera ship is not facing the clipped dome region. Options to try:
>    - The chase camera sits behind the ship (CHASE_BEHIND=14, CHASE_HEIGHT=4) looking
>      at a point CHASE_LOOK_AHEAD=20 ahead along the ship's +Z (`src/client/camera/pose-math.ts`).
>      The clipped far wall is toward the ANCHOR, so the ship must be YAWED to face the
>      anchor (dome centre) for the top band to look at the clipped region. `__SELF_SHIP__.probe().rot`
>      
