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
 * Per-file environments:
 *   - Default: `node` (TASK-1 prereqs, Fastify inject tests, etc.)
 *   - A test file that needs a browser-like environment adds a
 *     `// @vitest-environment happy-dom` pragma as the first line. This
 *     is the Vitest 4 replacement for the removed `environmentMatchGlobs`
 *     option. Used by `src/shared/random.parity.test.ts` (TASK-2) to
 *     prove Node/browser parity of the PRNG.
 *
 * We deliberately use `happy-dom` (not `jsdom`) — it's 10× faster to
 * spin up and we only need the *shape* of `globalThis.TextEncoder` and
 * `Uint8Array`, which both provide.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "prereqs.test.ts",
      "tests/abuse/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(HERE, "src/shared"),
      "@client": path.resolve(HERE, "src/client"),
      "@server": path.resolve(HERE, "src/server"),
    },
  },
});
