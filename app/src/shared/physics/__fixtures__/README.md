# Flight Model Golden Trajectory Fixtures

This directory holds the recorded deterministic trajectories that
prove the flight model is bit-stable across runs and clients.

## Files

- `trajectories.ts` — TypeScript module exporting the recorded
  fixtures as values (not JSON), keeping type-checking end-to-end and
  avoiding `import *.json` quirks with the test runner.

## Regeneration

If you change the physics constants or the ship catalog in a way
that shifts the final state, regenerate the fixtures:

```bash
cd app
tsx src/shared/physics/scripts/gen-trajectories.ts
```

That script runs the same `integrateShip` integration for
60 s in space + 30 s in atmosphere and rewrites
`trajectories.ts` with the new values. **Always commit the regenerated
fixtures alongside the physics change.**

## Why a `.ts` file, not `.json`?

The fixtures are pure values (no `Date.now`, no Math.random) — using
a TS module lets us type-check the `ShipState` shape against the
production type and prevents accidental JSON-parsing drift in the
test runner.

## Acceptance

`flight.test.ts > golden trajectory fixtures` re-runs both fixtures
end-to-end and asserts the resulting state matches the recorded
final to within `1e-9` per axis. The test fails loudly if the
physics integration diverges by even one float ULP.
