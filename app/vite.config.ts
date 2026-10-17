import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const HERE = import.meta.dirname;

/**
 * Vite config for the Drift client.
 *
 * - `PORT` (from `.env.local`) is the user-facing client port (defaults to
 *   3000). The Vite dev server listens there so the browser URL is
 *   `http://localhost:${PORT}`.
 * - The Fastify + ws server listens on `API_PORT` (defaults to `PORT + 1`)
 *   so the two coexist in dev without a port collision. Vite proxies `/api`
 *   and `/ws` to that internal port so the browser stays on a single origin.
 * - Path aliases mirror `tsconfig.json` so client and server share
 *   `@shared/*` imports without relative-path gymnastics.
 */
const PORT = Number(process.env.PORT ?? 3000);
const API_PORT = Number(process.env.API_PORT ?? PORT + 1);

export default defineConfig({
  plugins: [react()],
  root: path.resolve(HERE, "src/client"),
  publicDir: path.resolve(HERE, "src/client/public"),
  build: {
    outDir: path.resolve(HERE, "dist/client"),
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(HERE, "src/shared"),
      "@client": path.resolve(HERE, "src/client"),
      "@server": path.resolve(HERE, "src/server"),
    },
  },
  server: {
    port: PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
