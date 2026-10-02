/**
 * Production server build (`npm run build:server`): bundles the Fastify + ws
 * entry into a single CJS file at dist-server/index.js. npm packages stay
 * external (better-sqlite3 is native), the @server/@shared aliases resolve
 * from tsconfig paths, and the sqlite migrations are copied next to the
 * bundle because migrate.ts reads them from `__dirname/migrations`.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appDir, 'dist-server');

fs.rmSync(outDir, { recursive: true, force: true });

await build({
  absWorkingDir: appDir,
  entryPoints: ['src/server/index.ts'],
  outfile: path.join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

fs.cpSync(path.join(appDir, 'src/server/db/migrations'), path.join(outDir, 'migrations'), {
  recursive: true,
});
