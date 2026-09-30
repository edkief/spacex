/**
 * E2E dev harness (TASK-70): boots the Vite app + the API/WS server side by
 * side, exactly like `npm run dev`, but on ports/DB supplied via env so the
 * Playwright fixture (tests/e2e/fixtures.ts) can isolate each run:
 *
 *   VITE_PORT  — Vite origin port (default: a free port)
 *   API_PORT   — Fastify + ws port; Vite proxies /api and /ws to it
 *   DB_PATH    — sqlite file (default: ./data/drift.db; e2e passes a tmp file)
 *
 * SIGTERM/SIGINT are forwarded to both children (SIGKILL fallback after 8 s)
 * so the fixture's process-group kill tears the whole tree down.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const vitePort = Number(process.env.VITE_PORT ?? 0) || (await freePort());
const apiPort = Number(process.env.API_PORT ?? 0) || (await freePort());
const dbPath = process.env.DB_PATH ?? './data/drift.db';
console.log(`[dev:test] vite :${vitePort} · api/ws :${apiPort} · db ${dbPath}`);

// DEV_API_PORT is read by vite.config.ts for the /api + /ws proxy targets.
const sharedEnv = { ...process.env, DEV_API_PORT: String(apiPort) };

const vite = spawn(
  process.execPath,
  [
    path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--port',
    String(vitePort),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ],
  { cwd: appDir, env: sharedEnv, stdio: 'inherit' },
);

// Same tsx loader invocation as server-child.ts: the spawned PID is the real
// node process, so signals reach the server directly.
const tsxDist = path.join(appDir, 'node_modules', 'tsx', 'dist');
const server = spawn(
  process.execPath,
  [
    '--require',
    path.join(tsxDist, 'preflight.cjs'),
    '--import',
    pathToFileURL(path.join(tsxDist, 'loader.mjs')).href,
    path.join(appDir, 'src', 'server', 'index.ts'),
  ],
  {
    cwd: appDir,
    env: { ...sharedEnv, PORT: String(apiPort), DB_PATH: dbPath },
    stdio: 'inherit',
  },
);

const children = [vite, server];
let remaining = children.length;

for (const child of children) {
  child.on('exit', () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    process.exit(0);
  }, 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
