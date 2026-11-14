# Project Structure

```
app/
  src/
    shared/        code that runs verbatim in browser and Node (no DOM, no Node APIs)
    client/        Vite + React DOM shell; index.html owns the single <canvas id="drift-canvas">
    server/        Fastify REST + ws; config.ts (env validation), app.ts (buildServer), ws.ts, index.ts
  tests/
    e2e/           Playwright specs
    support/       test tooling (Chromium resolver)
```
