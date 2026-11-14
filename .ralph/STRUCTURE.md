# Project Structure

```
app/
  src/
    shared/        code that runs verbatim in browser and Node (no DOM, no Node APIs)
      random.ts    seeded hashing + PRNG (root of determinism)
      canonical.ts canonical JSON for fixtures/checksums
      galaxy/      stars, systems, surface chunks, noise, terrain, placement, fixtures
      ships/       ship class ids
    client/        Vite + React DOM shell; index.html owns the single <canvas id="drift-canvas">
    server/        Fastify REST + ws; config.ts (env validation), app.ts (buildServer), ws.ts, index.ts
  tests/
    e2e/           Playwright specs
    support/       test tooling (Chromium resolver, fixture helpers)
    guards/        source-scan guards (determinism rules)
    perf/          generation timing checks
```
