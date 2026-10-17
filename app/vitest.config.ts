import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const HERE = import.meta.dirname;

/**
 * Vitest config for the Drift workspace.
 *
 * Mirrors the Vite path aliases so tests can use `@shared/*`, `@client/*`,
 * and `@server/*` the same way the runtime code does. The Vite React plugin
 * is wired in so any future component-level tests in `src/client/**` work
 * out of the box.
 *
 * `app/prereqs.test.ts` (TASK-1) lives at the workspace root and runs in
 * `node` environment. Server tests use Fastify's `inject()` and stay in
 * `node` too, so we leave the default `node` environment in place.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "prereqs.test.ts"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(HERE, "src/shared"),
      "@client": path.resolve(HERE, "src/client"),
      "@server": path.resolve(HERE, "src/server"),
    },
  },
});
