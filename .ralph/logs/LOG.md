# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 13:18
**Tasks Completed:** 7 of 71
**Current Task:** TASK-6 Complete

----------------------------------------------

## Session Log

### 2026-10-17 — Iteration 7
- **TASK-6** Galaxy determinism verification (snapshot fixtures) → **DONE**
  - New `app/src/shared/galaxy/snapshots.test.ts` (212 lines, 8 cases) — six deep-equal scenarios:
    - full 200-star chart (`stars-dev-seed-full.json`) + checksum match,
    - `SystemGen` of star #0 (`system-dev-seed-star0.json`),
    - `SystemGen` of star #1 (`system-dev-seed-star1.json`),
    - `SurfaceChunk (0,0)` of star #0's first landable planet (`surface-dev-seed-star0-planet0-chunk00.json`) with full 4096-cell heightmap + legacy heightmap16/stats cross-check,
    - `SurfaceChunk (1,0)` (`surface-dev-seed-star0-planet0-chunk10.json`),
    - `SurfaceChunk (0,1)` (`surface-dev-seed-star0-planet0-chunk01.json`).
    On mismatch, prints the first divergent dot-path so the failure self-diagnoses.
  - New `app/src/shared/galaxy/snapshots.mutation.test.ts` (71 lines, 2 cases) — proves the suite is sensitive to generator drift: a deliberately-mutated clone of `generateStars` with O ↔ M spectral weights swapped is shown to diverge from the committed chart on both distribution and checksum. Sanity test ensures the real generator still matches.
  - New `app/src/shared/galaxy/snapshots.helpers.ts` (222 lines, non-test) — `DEV_SEED`/`STAR0_INDEX`/`STAR1_INDEX` constants, `loadFixture`, `firstDivergentPath` walker, `loadPlanetFromSurfaceFixture`, fixture-shape types, and `mutatedGenerateStars` (kept here so the production code path is clean).
  - New `app/src/shared/galaxy/__fixtures__/README.md` — fixture-regeneration rules; only `npm run snapshot:update` writes, the default `npm run test` only reads.
  - New `app/src/shared/galaxy/__fixtures__/stars-dev-seed-full.json` (full 200-star chart + checksum) — added alongside the existing first-25 parity fixture, which still passes `stars.parity.test.ts`.
  - New `app/src/shared/galaxy/__fixtures__/system-dev-seed-star1.json` — full SystemGen for star #1 (Perexnius, 2 planets).
  - New `app/src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk10.json` and `surface-dev-seed-star0-planet0-chunk01.json` — full SurfaceChunk for chunks (1,0) and (0,1) respectively.
  - `app/src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk00.json` extended with the full 4096-cell `heightmap` field (legacy `heightmap16` + `heightmapStats` retained for the existing parity test).
  - New `app/scripts/gen-stars-full-fixture.ts`, `gen-system-star1-fixture.ts`, `gen-surface-chunk10-fixture.ts`, `gen-surface-chunk01-fixture.ts` — one-off regenerators (mirror TASK-3/4/5 patterns).
  - `app/scripts/gen-surface-fixture.ts` updated to also emit the full `heightmap` field.
  - `app/package.json` — `npm run snapshot:update` chains all five regenerators (`gen-stars-full`, `gen-system-star1`, `gen-surface`, `gen-surface-chunk10`, `gen-surface-chunk01`).
  - **Mutation verification**: temporarily changed `PEAK_HEIGHT_M` in `config-surface.ts` from `2000` to `1500`; the snapshot suite failed 3 tests (the three surface-chunk scenarios), confirming the suite catches real generator drift. Reverted, all tests green.
  - 151/151 vitest cases pass (9 new in `snapshots.*.test.ts`, 0 pre-existing regressions). `npm run typecheck`, `npm run lint` (eslint + prettier --check), and `npm run lint:fix` all clean. File-size policy respected (each `snapshots.*.ts` under 300 lines). TASK-6 is `functional` (no UI surface) → no Playwright smoke needed. No screenshot.

### 2026-10-17 — Iteration 6
- **TASK-5** Surface chunk generator (terrain, nodes, landing pads) → **DONE**
  - New `app/src/shared/galaxy/{surface,surface-noise,surface-placement,config-surface}.ts` module quartet (172+322+248+207 lines):
    - `config-surface.ts` — `CHUNK_SIZE_CELLS=64`, `PEAK_HEIGHT_M=2000`, `FBM_BASE_LATTICE_SPACING_M=64` (1 lattice per chunk for boundary continuity), `FBM_OCTAVES=3`/`FBM_GAIN=0.5`, biome thresholds (frozen/canyon/wetland/rock), `MIN/MAX_NODES_PER_CHUNK=1..4`, `NODE_MIN_SPACING_M=4`, `PAD_PROBABILITY=0.25`, `PAD_BLOCK_SIZE_CELLS=4`.
    - `surface-noise.ts` — value noise + smoothstep interp, fBm sum, `generateHeightmap(terrainSeed, cx, cz)` (64x64 row-major metres, world-space sampling), `sampleMoisture`/`sampleLatitude` (decorrelated fBm channels), `classifyBiome` (5-way ordered classifier). MurmurHash3-style `latticeValue` uses Number+Math.imul arithmetic (~25x faster than BigInt hash2 for the 32k calls/celletash hot path).
    - `surface-placement.ts` — `placeResourceNodes` (1..4 seeded nodes via rejection sampling, restricted to planet.resourceTypes, empty for wetlands), `placeLandingPads` (0..1 pad per chunk, forced on chunk (0,0) of landable planets, flattest spot via 4x4 block gradient scan), `nodeId`/`padId` (16-hex stable keys from chunkSeed + nodeIndex/padIndex).
    - `surface.ts` — public `generateSurfaceChunk(seed, planet, chunkX, chunkZ)`. Derives two seeds: `placementSeed` (per-chunk, drives RNG for nodes/pads) and `terrainSeed` (per-planet, drives the noise field — this is what guarantees boundary continuity).
  - Updated `app/src/shared/galaxy/types.ts`: expanded `SurfaceChunk` to the full schema; added `Biome`, `ResourceNode`, `LandingPad`, `BIOMES` canonical list. The ResourceNode.type stays `string` in the wire shape but is always a `ResourceType` value at runtime.
  - One-off regenerator `scripts/gen-surface-fixture.ts` — writes `__fixtures__/surface-dev-seed-star0-planet0-chunk00.json` (dev seed, star 0's first landable planet — orbit 0 rocky with iron resources, 4 nodes, 1 pad, biome=canyon).
  - Test files (3 new + 1 new fixture, 30 new cases → 142 total):
    - `surface.test.ts` (345 lines) — shape (chunk coords, 64x64 heightmap, valid biome, 0..1 pads, non-integer coord rejection); resource nodes (1..4 bound, types ⊆ planet.resourceTypes, 16-hex ids unique within chunk, baseQuantity ∈ [50, 200], positions in [0..63), wetland chunks empty); landing pads (chunk (0,0) forced to 1 pad, 16-hex ids, positions in chunk, non-landable planets have no pads, other chunks ≤1 by PAD_PROBABILITY); determinism (deep equal across calls, different chunks different, 30 random chunks across 3 planets stable across two runs); helpers (16-sample fingerprint).
    - `surface.boundary.test.ts` (160 lines) — chunks (0,0) and (1,0) share a small delta at their shared column (max ≤ 25m, median ≤ 10m; empirically ≤ 5m/2m across 4 seeds × 5 stars), chunks (0,0) and (0,1) share a small delta at their shared row (max ≤ 25m); biome distribution (≥ 2 distinct biomes across 100 chunks); heightmap stats (computeHeightmapStats agrees with the actual heightmap contents); node id stability across calls.
    - `surface.parity.test.ts` (129 lines) — committed fixture exists + well-formed; regenerating chunk (0,0) from the fixture's inputs reproduces heightmap16 + heightmapStats + biome + resourceNodes + landingPads exactly under happy-dom; `sampleLandablePlanet()` matches the fixture's planet; regeneration idempotent within the same process; parametric source purity check across `surface.ts`, `surface-noise.ts`, `surface-placement.ts` (no Math.random, Date.now, globalThis, crypto, performance.now).
    - `surface.helpers.ts` (158 lines) — `DEV_SEED`, `STAR_INDEX`, `FIXTURE_CHUNK_X/Z`, `sampleLandablePlanet()`, `loadSurfaceFixture()`, `sampleHeightmap16()`, `computeHeightmapStats()`, `generateFixtureChunk()`, `SurfaceFixture` type.
  - **Performance**: ~5ms per chunk; 30 chunks stability test runs in well under a second. The MurmurHash3 finalizer + Number arithmetic for lattice values gives ~25x speedup vs. the BigInt hash2 chain; combined with the 3-octave fBm (vs. 5), chunk generation went from 63ms to ~5ms.
  - **Boundary continuity fix**: originally the heightmap used the per-chunk `placementSeed`, which broke the noise field continuity at chunk borders (max delta ~1277m at 2000m peak). Switched to a planet-scoped `terrainSeed` (= `hash2(galaxySeed, planetIdSeed)`); empirically max delta across 4 seeds × 5 stars is ≤ 5m, median ≤ 2m — well inside the 25m/10m test thresholds.
  - 142 vitest cases pass (30 new from TASK-5 + 112 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm test` all clean. TASK-5 is `functional` (no UI surface) → no Playwright smoke needed. No screenshot (no UI).

### 2026-10-17 — Iteration 5
- **TASK-4** System generator (planets, docks, deposits, AI roster) → **DONE**
  - New `app/src/shared/galaxy/{system,planet,config-system}.ts` module trio:
    - `config-system.ts` (138 lines) — `PLANET_COUNT_MIN/MAX = 2..6`, `PLANET_RADIUS_*` (gas 20k..60k km, others 2k..8k), `PLANET_CLASS_WEIGHTS` (rocky 28% / terran 18% / ocean 14% / gas 20% / ice 20%, sum-to-1.0), `ATMOSPHERE_PROBABILITY` (gas/terran/ocean always yes; rocky 0.5; ice 0.3), `DOCK_COUNT_MIN/MAX = 1..3`, `AI_ROSTER_MIN/MAX = 2..5`, `RESOURCE_PICKS_MIN/MAX = 1..3`, `SYSTEM_NAME_SUFFIX = " system"`.
    - `planet.ts` (220 lines) — `generatePlanet(parentStarId, systemSeed, orbitIndex)` builds one Planet independently from its own sub-Rng keyed by `hash2(systemSeed, BigInt(orbitIndex))`. Class/radius/atmosphere/landability/dock/resource/roster all flow through the planet's Rng so sibling planets are decorrelated.
    - `system.ts` (175 lines) — `generateSystem(seed, star)` and the `Star | starId` overload produce `SystemGen = { systemId, name, star, planets }`. `systemId = hex(hash2(masterSeed, seedFromString(star.id)))`; `name = "{star.name}{SYSTEM_NAME_SUFFIX}"`. Planet ordering is orbit-index ascending (asserted); gas giants are never landable (hard invariant).
  - New types in `app/src/shared/galaxy/types.ts`: `PlanetClass`, `ResourceType`, `ShipClassId`, `AIRoster`, `Planet` (full body matching spec), `SystemGen` (the deterministic output envelope), updated `SystemSummary` (lightweight pointer). `PLANET_CLASSES`, `RESOURCE_TYPES`, `SHIP_CLASS_IDS` canonical lists alongside.
  - Roman-numeral planet naming (`Planet`, `Planet I`, `Planet II`, …) — deterministic, unique within the system, no extra word list.
  - One-off regenerator `scripts/gen-system-fixture.ts` — writes `__fixtures__/system-dev-seed-star0.json` (seed `drift-dev-seed-001`, star index 0, 4 planets: rocky/terran/terran/ice with full SystemGen envelope).
  - Test files (5 new):
    - `config-system.test.ts` (85 lines, 7 cases) — weight sum-to-1.0, bounds (2..6, 2k..8k/20k..60k, 1..3, 2..5, 1..3), atmosphere probability range, landable probability range.
    - `planet.test.ts` (67 lines, 5 cases) — id derivation (id == hex(hash2(systemSeed, orbitIndex))), orbitIndex passthrough, roster bound, deterministic-replay, distinct-orbit→distinct-id.
    - `system.test.ts` (274 lines, 18 cases) — generateSystem invariants: 2..6 planets, systemId 16-hex, name == "{star} system", planet id uniqueness, orbit ordering, class validity, all-spec'd-fields-populated, gas-never-landable, dockCount bounds for landable/non-landable/gas, radius range per class, atmosphere class conditional, resource uniqueness, AI roster validity, two-call determinism, (Star object) vs (starId) parity, statistical ≥80% landable+atmosphere over 200 systems, divergent seeds, systemId formula correctness.
    - `system.parity.test.ts` (85 lines, 4 cases) — golden fixture well-formed, regenerates identically under happy-dom, byte-stable systemId, source purity (no Math.random/Date.now/globalThis/crypto/performance).
    - `system.helpers.ts` (77 lines, non-test) — shared `DEV_SEED`, `TEST_SEEDS`, `STAR_INDEX`, `VALID_PLANET_CLASSES/SHIP_CLASSES/RESOURCE_TYPES`, `sampleStar()`, `bigintToHex()`, `loadSystemFixture()`.
  - 110 vitest cases pass (71 new from TASK-4 + 39 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm test` all clean. TASK-4 is `functional` (no UI surface) → no Playwright smoke needed. No screenshot (no UI).

### 2026-10-17 — Iteration 4
- **TASK-3** Star generator (seeded galaxy layout) → **DONE**
  - New `app/src/shared/galaxy/` module with:
    - `types.ts` — `Star`, `SpectralClass`, and placeholder interfaces (`SystemSummary`, `Planet`, `SurfaceChunk`) so future tasks can extend them without breaking the import graph.
    - `config.ts` — `GALAXY_STAR_COUNT = 200`, `SYSTEM_COUNT_MIN/MAX = 2..8`, log-normal disk geometry, spectral class weights (O=0.5%, …, M=37.5%, sum = 1.0), and three **disjoint** name word lists (52/54/52 entries — capital prefixes, lowercase consonant-vowel-consonant roots, lowercase vowel-ending suffixes; enforced by the test suite).
    - `stars.ts` — `generateStars(seed, count?)` using `Rng` (TASK-2) + `hash2(masterSeed, BigInt(i))` sub-seeds. Position: log-normal radius + uniform theta + thin Gaussian z (rounded to 6 decimals for cross-platform stability). Name: `prefix+root+suffix` with bounded retry loop for uniqueness. Class: weighted pick from the master RNG (so the *sequence* of classes is fixed). `id` is the zero-padded 16-char hex of the sub-seed.
    - `canonical.ts` — `canonicalJson(value)` (sorted keys, locale-independent number rendering, rejects NaN/±Infinity/undefined) and `starListChecksum(stars)` (FNV-1a 64-bit folded twice with different offsets → 128-bit hex digest, Node + browser).
  - Golden snapshot fixture committed: `app/src/shared/galaxy/__fixtures__/stars-dev-seed.json` (seed `drift-dev-seed-001`, count 200, first 25 stars + checksum `6d05a1f1075b13d70e10737e6cf0c9c0`).
  - `scripts/gen-stars-fixture.ts` — one-off regenerator (`npx tsx scripts/gen-stars-fixture.ts`) for when the generator intentionally changes.
  - Two test files: `stars.test.ts` (36 cases) and `stars.parity.test.ts` (happy-dom parity, 4 cases). Coverage:
    - Config tunables: count, systemCount bounds, spectral weights sum-to-1.0, ordering O<B<A<F<G<K<M, list min length, no-overlap, alphabetic.
    - Generator: default 200, custom count (incl. 0), input validation, determinism across 5 seeds, divergence on different seeds, unique ids, unique names, 16-hex id format, valid class, systemCount in range, name length ≤ 24.
    - Position: |xy| ≤ 30, |z| < 2, star 0 id equals `hash2(master, 0n)` (sub-seed independence).
    - Class distribution: roughly matches weights (single-seed loose + 5-seed cumulative ordering).
    - Golden: fixture exists & well-formed, first-25 equality, count equality, checksum equality, mutation sensitivity.
    - Canonical: sorted keys, nested, integer/float rendering, rejects NaN/Infinity/undefined, checksum order-independent.
  - 75 vitest cases pass (39 new + 36 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix` all clean. TASK-3 is `functional` (no UI surface) → no Playwright smoke needed.

### 2026-10-17 — Iteration 3
- **TASK-2** Shared deterministic PRNG + hash library → **DONE**
  - New module `app/src/shared/random.ts` (280 lines) — pure TypeScript, zero imports.
    Exports:
      - `seedFromString(s: string): bigint` (FNV-1a 64-bit over UTF-8 bytes via `TextEncoder`).
      - `Rng` class (xoshiro128** over a 4×U32 state seeded from any `bigint` via 4× splitmix64 rounds) with `nextU32()`, `nextF64()`, `nextRange(min, max)`, `nextInt(n)`, `pick(arr)`, `nextGauss(mean, sd)`.
      - `hash2(a, b): bigint` (XOR-multiply mix + splitmix64 finalizer) for per-entity sub-seeds.
  - Two test files: `random.test.ts` (node env) and `random.parity.test.ts` (happy-dom env via per-file `// @vitest-environment` pragma). The Vitest 4 default is to use the per-file pragma; `environmentMatchGlobs` was removed in v4 so the existing `vitest.config.ts` was updated to document the per-file pattern.
  - 36 vitest cases pass (21 new + 15 pre-existing). Coverage:
      - Golden values for `seedFromString` on 4 known strings (incl. FNV offset basis check on `""`).
      - Golden `nextU32()` and `nextF64()` sequences for `drift-dev-seed-001` (8 each).
      - Rng construction determinism + cross-seed divergence.
      - `hash2` stability and order-sensitivity.
      - `nextRange`, `nextInt` (incl. distribution), `pick`, `nextGauss` (mean/sd check).
      - 100k-sample chi-square-lite uniformity test (per-bin dev < 20%, chi² < 21.7 at 9 d.o.f.).
      - Source purity: reads `random.ts`, strips comments, asserts no `Math.random`, `Date.now`, `Date.constructor`, `crypto`, `globalThis.*`, or `performance.now`.
      - Happy-dom parity: same digest/U32/F64/hash2 values under `// @vitest-environment happy-dom`.
  - Added `happy-dom` to `app/devDependencies` (lighter than jsdom; we only need `TextEncoder` / `Uint8Array` shape).
  - `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm run test` all clean. No UI surface → no Playwright smoke needed for this task (TASK-2 is `functional` not `ui-ux`).

### 2026-10-17 — Iteration 2
- **TASK-68** Scaffold TS monorepo (client/server/shared) with tooling → **DONE**
  - Created `app/src/{shared,client,server}` trees with strict TypeScript (`tsconfig.json`, target ES2022, module ESNext, moduleResolution bundler, `strict: true`).
  - Path aliases wired in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`: `@shared/*`, `@client/*`, `@server/*`.
  - Server (`src/server/`): `config.ts` loads `PROJECT_ROOT/.env.local` via dotenv with defaults; `server.ts` exposes `buildApp()` (testable via Fastify `inject()`); `ws.ts` attaches a `ws.Server` at `config.wsPath`; `index.ts` listens on `apiPort = PORT + 1` (default 3001) so Vite (PORT=3000) and Fastify don't collide.
  - Client (`src/client/`): `main.tsx` mounts a React shell, `App.tsx` lays out a stable `<canvas>` placeholder (`data-testid="drift-canvas"`) for the three.js renderer, plus a "DRIFT — SCAFFOLD" HUD label; Vite proxies `/api` and `/ws` to the Fastify server.
  - Tooling: `npm run dev` (concurrently vite + tsx), `npm run build` (vite build), `npm run test` (vitest), `npm run typecheck` (tsc --noEmit), `npm run lint` (eslint + prettier --check), `npm run start` (tsx server). Plus `eslint.config.js` (flat config, typescript-eslint + prettier) and `.prettierignore`.
  - Tests: 15 vitest cases pass (3 files: prereqs, shared/health, server/server). One Playwright e2e (`tests/e2e/scaffold.spec.ts`) renders the React shell, asserts the canvas is visible, hits `/api/health` through the Vite proxy, and fails on any console error.
  - Smoke verified end-to-end: `curl http://localhost:3000/api/health` (proxied) and `curl http://localhost:3001/api/health` (direct) both return `{"ok":true,"galaxySeed":"DRIFT-SEED-0001"}`; `ws://localhost:3001/ws` upgrades and replies `{"type":"hello",...}`.
  - Screenshot: `.ralph/screenshots/TASK-68-1.png` — shows the dark canvas with the "DRIFT — SCAFFOLD" header (no console errors).
  - `.gitignore` updated to exclude `app/data/`, `data/`, `playwright-report/`, `test-results/`, and `.pi/`.
  - `.ralph/STRUCTURE.md` refreshed to reflect the new `app/src/**` layout.

### 2026-10-17 — Iteration 1
- **TASK-1** Verify project prerequisites and access → **DONE**
  - Confirmed `.env.local` exists with all 8 required names from PRD §7 (PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, DATABASE_URL, SYSTEM_INSTANCE_COUNT, WS_PATH); `SESSION_SECRET` filled with a 64-char hex value (length checked only — value never exported).
  - `.env.local` is git-ignored; secret value is not present in any tracked file or in chat/PRD/task artifacts.
  - Verified `better-sqlite3@^11` resolves and can create/read `./data/drift.db` (DB_PATH) inside the sandbox.
  - MCP servers (playwright, context7, sequential-thinking) are declared in `.mcp.json` and reachable on npm (registry HEAD OK).
  - All five PRD §7 documentation links return HTTP 200 (three.js, Fastify, ws, Drizzle ORM, better-sqlite3).
  - Callsign-only auth confirmed (no test user setup needed); e2e planned against `TEST-ALPHA` / `TEST-BRAVO` (created at runtime, no secrets).
  - Recorded **user-approved proceed gaps** (per TASK-1 step 4 / acceptance criteria):
    1. No live Postgres in this sandbox — PG parity will be exercised via Drizzle dual-driver unit tests on SQLite now and against the postgres-js adapter in CI later. Live PG validation is post-v1.
    2. Headless CI WebGL is functional-only; render-performance verification (SC-1/SC-4/SC-5) will be confirmed on reference hardware, not in this sandbox.
  - Added automated guard test at `app/prereqs.test.ts` (12 vitest cases) so a future regression in any of the above items fails CI.
  - Dev server (`npm run dev`) was **not** started: the app scaffold lands in TASK-68, and `app/package.json` currently has no `scripts` entry. Start deferred to that task.
  - No screenshot — TASK-1 is environment/setup verification with no UI surface yet.
