# Galaxy snapshot fixtures (TASK-6)

These JSON files are the regression guard for SC-2 ("the galaxy must be
byte-stable across runs and platforms for a given seed"). Every
generator output listed below is committed **frozen** — any change to a
generator that affects a fixture byte must:

1. be intentional and reviewed,
2. be paired with a regenerated fixture (`npm run snapshot:update`),
3. be flagged in the commit message as a "breaking seed behaviour"
   change, so the wider team can scan for it.

The fixtures are checked in `shared/galaxy/snapshots.test.ts`. The
default test command (`npm run test`) only **reads** the fixtures — it
never writes to them. Only the explicit `npm run snapshot:update`
command does.

## What's locked here

| File                                          | Pins down                                                     |
| --------------------------------------------- | ------------------------------------------------------------- |
| `stars-dev-seed-full.json`                    | The full 200-star chart from `drift-dev-seed-001` (TASK-3).   |
| `stars-dev-seed.json`                         | First 25 stars + checksum (TASK-3 parity fixture).            |
| `system-dev-seed-star0.json`                  | `SystemGen` for star #0 of the dev seed (TASK-4).             |
| `system-dev-seed-star1.json`                  | `SystemGen` for star #1 of the dev seed (TASK-4 / TASK-6).    |
| `surface-dev-seed-star0-planet0-chunk00.json` | Full `SurfaceChunk (0,0)` of star #0's first landable planet. |
| `surface-dev-seed-star0-planet0-chunk10.json` | Full `SurfaceChunk (1,0)` of the same planet (TASK-6).        |
| `surface-dev-seed-star0-planet0-chunk01.json` | Full `SurfaceChunk (0,1)` of the same planet (TASK-6).        |

## How to regenerate

```bash
npm run snapshot:update
```

This runs each of the per-scenario regenerator scripts under
`app/scripts/`. Each script prints what it wrote and where. Commit the
changed files after reviewing the diff — a one-line change to a
fixture is the most common sign of a benign retune; a sprawling diff
usually means an unintentional generator regression.

## What the snapshot test guards against

`shared/galaxy/snapshots.test.ts` reads each fixture, regenerates the
corresponding object from the current code, and `toEqual`s them. If a
PR edits a tunable, swaps a hash function, or otherwise shifts the
output, the test fails and prints the first divergence path so the
diff is quick to diagnose.

A deliberately-failing case is included: the mutation test flips a
class weight (see `snapshots.test.ts → "mutation: flipping a class
weight breaks the star chart"`). It serves as a sanity check that
the suite is _actually_ catching regressions, not just trivially
green.
