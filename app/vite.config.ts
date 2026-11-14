import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { loadEndpointConfig } from './src/server/config.ts';
import { findAppDir, loadAppEnv } from './src/server/env.ts';

const appDir = findAppDir(import.meta.dirname);
const { host, port, apiPort, wsPath } = loadEndpointConfig(loadAppEnv(appDir));
const apiTarget = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${apiPort}`;

// Vite serves the client on PORT and proxies REST + WebSocket to the Node server on API_PORT,
// so the browser stays same-origin. Aliases come from tsconfig.json `paths` (single source).
export default defineConfig({
  root: path.join(appDir, 'src/client'),
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  server: {
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget },
      [wsPath]: { target: apiTarget, ws: true },
    },
  },
  build: {
    outDir: path.join(appDir, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
