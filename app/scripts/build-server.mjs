/**
 * Production server build (`npm run build:server`): bundles the Fastify + ws
 * entry into a single ESM file at `dist-server/index.js`. npm packages stay
 * external (better-sqlite3 is a native module), the `@server`/`@shared`/`@client`
 * aliases resolve from the tsconfig paths, and the sqlite migrations are copied
 * next to the bundle because `migrate.ts` reads them from
 * `<dirname>/migrations/sqlite`.
 *
 * The output is ESM to match the package `"type": "module"`: the server code
 * uses `import.meta.url` / `import.meta.dirname` to locate the migrations and
 * the project root, neither of which survives a CommonJS bundle.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(appDir, "dist-server");

fs.rmSync(outDir, { recursive: true, force: true });

await build({
  absWorkingDir: appDir,
  entryPoints: ["src/server/index.ts"],
  outfile: path.join(outDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});

fs.cpSync(path.join(appDir, "src/server/db/migrations"), path.join(outDir, "migrations"), {
  recursive: true,
});
