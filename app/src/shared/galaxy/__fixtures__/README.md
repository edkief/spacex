# Galaxy determinism fixtures

These files lock the output of the deterministic galaxy generators for the dev seed
`drift-dev-seed-001`. They are the regression guard for success criterion SC-2: any two clients
and the server must derive a bit-identical galaxy from `GALAXY_SEED`, because geometry is never
stored or sent.

| File                  | Contents                                                              |
| --------------------- | --------------------------------------------------------------------- |
| `stars-dev-seed.json` | Full 200-star chart, its count, and sha256 of the compact canonical JSON |
| `system-star-0.json`  | `generateSystem` for star #0 of the chart                             |
| `system-star-1.json`  | `generateSystem` for star #1 of the chart                             |
| `surface-0-0.json`    | Chunk (0,0) of the dev-seed landable planet                           |
| `surface-1-0.json`    | Chunk (1,0) of the same planet                                        |
| `surface-0-1.json`    | Chunk (0,1) of the same planet                                        |
| `galaxy-digests.json` | sha256 over all 200 systems and over an 8x8 chunk grid per planet class |

"The dev-seed landable planet" is the first landable planet found scanning the chart in star
order (`firstPlanet` in `tests/support/galaxy.ts`). Star #0 happens to have only gas giants, so
this is currently a planet of star #2.

`galaxy-digests.json` exists because the six detailed fixtures cover only two systems and three
chunks, so a small probability or constant change can slip past them (a mutation check showed a
0.25 -> 0.26 pad chance and a 0.95 -> 0.94 landable chance went unnoticed). The digests cover
every system plus 64 chunks on each of the four landable planet classes. No finite fixture can catch every
tiny change (the pad-chance tweak above is detected by this grid only because 64 chunks per class
make a hit very likely), so treat the fixtures as a strong tripwire, not a proof.

Surface fixtures record everything verbatim except the 4096-value heightmap, which is stored as
its length, a sha256 of its compact canonical JSON, and 16 sampled `(i, j, value)` points so a
diff stays readable. The unit is decimetres (see `terrain.ts`).

## Format

Every file is `canonicalStringify(value, 2) + "\n"` from `src/shared/canonical.ts`: object keys
sorted, 2-space indent, numbers in shortest round-trip form. NaN, Infinity, `undefined` and -0 are
rejected at serialisation time, never written.

## Do not edit by hand, and regenerate only deliberately

The default test run only compares; it never writes. Regenerate only after a generator change
that has been approved as intentionally breaking seed behaviour:

```sh
npm run snapshot:update
```

Then review the diff, and note in the commit message that existing seeds now produce a different
galaxy (saved worlds and DB ids keyed off these outputs will change).

## What these fixtures do and do not prove

- They prove the generators are stable across runs and code changes on the same JS engine, and
  that `src/shared` imports cleanly in both vitest projects (node and jsdom).
- jsdom runs on the same V8 as node, so the `.parity.test.ts` suites do **not** prove cross-engine
  equality. Real cross-engine proof (V8 vs SpiderMonkey vs JavaScriptCore) needs the browser e2e
  work in TASK-71.
- Cross-engine safety rests on the generation code using only exactly-specified arithmetic
  (`+ - * /`, `Math.sqrt`, floor/round/min/max/abs/imul, integer and BigInt ops). That is enforced
  by an eslint rule scoped to `src/shared/random.ts` and `src/shared/galaxy/**`, and by the source
  scan in `tests/guards/determinism.test.ts`.
- The golden values were also reproduced by an independent Python implementation of the
  algorithms (FNV-1a 64, splitmix64, xoshiro128**, the noise lattice and placement logic).
