# Project Structure

```
app/
  src/
    shared/        code that runs verbatim in browser and Node (no DOM, no Node APIs)
      random.ts    seeded hashing + PRNG (root of determinism)
      canonical.ts canonical JSON for fixtures/checksums
      galaxy/      stars, systems + layout, surface charts, chunks, noise, terrain, placement, fixtures
      physics/     vectors, bodies, frames (system <-> surface charts), flight, travel scaling, docking
      regime.ts    space/atmosphere/surface resolution
      ships/       ship class ids and stat catalog
      protocol/    message schemas, registries, envelope, error and close codes
    client/        Vite + React DOM shell; index.html owns the single <canvas id="drift-canvas">
    server/        Fastify REST + ws; config.ts (env validation), app.ts (buildServer), ws.ts, index.ts
      auth/        token codec and session service
      routes/      REST routes
      ws/          connection, state machine, dispatcher, handlers, heartbeat, origin check, hub
      ratelimit.ts token bucket, chat window, violation tracking
      directory.ts SystemDirectory seam (stub until shards exist)
      db/          Drizzle schema (single source), pg derivation, connection, per-aggregate repositories
      persist.ts   save-point service (dock, damage thresholds, interval, shutdown); helpers in persist/
  docs/            world-model.md (coordinate, scale and flight model)
  drizzle/         generated SQL migrations per dialect (sqlite/, pg/)
  tests/
    e2e/           Playwright specs
    support/       test tooling (Chromium resolver, fixture helpers)
    guards/        source-scan guards (determinism rules)
    perf/          generation and persistence timing checks
    crash/         SIGKILL recovery tests
```
