import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The Node server (Fastify + ws) runs on this port in dev; the Vite dev
// server proxies /api and /ws to it so the browser stays same-origin.
const DEV_SERVER_PORT = 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: `http://localhost:${DEV_SERVER_PORT}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${DEV_SERVER_PORT}`,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@client': path.resolve(__dirname, 'src/client'),
      '@server': path.resolve(__dirname, 'src/server'),
    },
  },
});
