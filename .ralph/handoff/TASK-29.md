## Status
Implemented deterministic pad derivation logic. Started investigating server-side integration for docking states.

## Done
- Created `app/src/shared/world/pads.ts` implementing `padsFor(seed, starId)`.
- `padsFor` deterministically derives:
    - One pad for each landable planet (positioned at surface chunk 0,0, taking height into account).
    - One pad for the system's space station (positioned at a deterministic distance/angle from the star).
- Identified the integration point in `app/src/server/shard/shard.ts` (`onTick` loop) for implementing the 'docked' state machine.

## Working tree
- `app/src/shared/world/pads.ts`: New file implementing the pad derivation.
- No changes to existing files yet; the project still builds.

## Next steps
- **Implement Server Pad State (Step 2):**
    - Update `Shard` to cache the results of `padsFor` for the current system.
    - In `Shard.onTick`, iterate through ships and check for docking conditions:
        - Distance < 20m to pad center.
        - Vertical speed < 2 u/s.
        - Altitude < 1m above pad height.
    - Manage the `docked` state (including hysteresis for the 20-25m boundary).
    - Broadcast `entity_update.state = 'docked' {padId}` when state changes.
- **Implement VTOL Assist (Step 3):**
    - Update the physics integration logic to damp horizontal drift (0.5x) when the VTOL key is held and the ship is within 100m of a pad and below 50 u/s.
- **Client Integration (Step 3):**
    - Implement glowing ring markers at pad positions (visible within 500m).
    - Add the "DOCKED" indicator to the HUD.
- **Verification (Step 4):**
    - Write unit tests for pad resolution and docking transitions.
    - Implement the sim convergence test (scripted approach converges in < 15s).
    - Create a Playwright E2E test to verify docking visually and in the DOM.

## Dead ends
- None.

## How to verify
- Currently, the `padsFor` function can be verified by writing a simple unit test to check that it returns the same pads for the same seed/starId.
- Future steps will be verified via `npm run test` and Playwright screenshots.
