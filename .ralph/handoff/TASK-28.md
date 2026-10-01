# Handoff: TASK-28

Written by Ralph: the agent ran out of time without leaving a complete handoff,
so this records what the loop could see.

## Status

Iteration 4 did not finish the task: Iteration exceeded its 45m budget; Wrap-up exceeded its 10m budget.

## Done

No commits during the iteration.

## Working tree

Uncommitted changes when it stopped:

```
 M app/scripts/gen-flight-fixtures.ts
 M app/src/server/shard/index.ts
 M app/src/server/shard/shard.ts
 M app/src/shared/galaxy/planets.test.ts
 M app/src/shared/galaxy/planets.ts
 M app/src/shared/physics/__fixtures__/flight-atmo-30s.json
 M app/src/shared/physics/atmosphere.ts
 M app/src/shared/physics/flight.test.ts
 M app/src/shared/physics/flight.ts
?? app/src/shared/physics/atmosphere.test.ts
```

## Next steps

Read the agent's last messages below and any uncommitted changes, decide what is worth
keeping, then continue the task.

## Dead ends

Not recorded.

## How to verify

Follow the task spec.

## The agent's last messages

> Let me look at the existing TASK-22 tests and how the ramp is tested, plus the client render structure.
>
>
> Let me check the git history for TASK-22 and the fixtures to understand the intended ramp direction.
>
>
> The existing ramp direction seems inverted relative to the TASK-28 spec. Let me check TASK-22's spec and the regime manager to resolve this.
>
>
> Now let me examine the client render side — WorldManager, starfield, main.tsx, and how the HUD/cockpit renders.
>
>
> Now I have the full picture. Let me check the remaining flight tests and PredictionContext type, then start implementing.
>
>
> Now I have everything I need. Starting implementation — first the shared physics core.
>
>
> Now the per-planet density in `planets.ts`:
>
>
> Now updating `flight.test.ts`. First the imports and helpers:
>
>
> Now let me numerically check the analytic-curve tolerance before writing the sim test. Quick experiment:
>
>
> Now let me verify the terminal-velocity scenario numbers before writing the test:
>
>
> Now writing the new boundary test block:
>
>
> Now the terminal-velocity test (rewrite for the inverted ramp):
>
>
> Now update all remaining `PlanetAtmo` literals. Let me view the exact spots:
>
>
> Now update the fixture generator and regenerate:
>
>
> Now regenerate fixtures and run the shared tests:
>
>
> Four clear fixes needed. First, the `reentryTintFactor` bug (missing `boundary` multiplication):
>
>
> Now the pure-math unit tests. Let me check the existing planets.test.ts first:
>
>
> One-character bug in my work (`DENSITY_SUBSEED` needs to be a bigint). Fixing it before handoff:
>
>
> Shared suite fully green. Quick full-suite + typecheck to document the handoff state:
>
>
> Client and shared are green; 2 deterministic failures in `shard.regime.test.ts` (expected fallout of the physics change). Writing the handoff now:
