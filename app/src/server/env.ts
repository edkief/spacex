import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** A bag of environment variables; `process.env` satisfies this shape. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Walks up from `startDir` to the nearest directory containing a package.json.
 * Works from `src/server` (tsx), `dist-server` (bundled) and the app root alike.
 */
export function findAppDir(startDir: string): string {
  let dir = path.resolve(startDir);
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package.json found above ${startDir}`);
    dir = parent;
  }
  return dir;
}

/** Resolves PROJECT_ROOT: the `PROJECT_ROOT` env var if set, else the parent of the app dir. */
export function resolveProjectRoot(appDir: string, base: EnvSource = process.env): string {
  const configured = base['PROJECT_ROOT'];
  return configured ? path.resolve(configured) : path.dirname(appDir);
}

/**
 * Reads PROJECT_ROOT/.env.local with dotenv and merges it under `base`, so real environment
 * variables win over the file. A missing file is fine; values are never logged.
 */
export function loadAppEnv(appDir: string, base: EnvSource = process.env): EnvSource {
  const envFile = path.join(resolveProjectRoot(appDir, base), '.env.local');
  const fromFile = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
  const defined = Object.entries(base).filter(([, value]) => value !== undefined);
  return { ...fromFile, ...Object.fromEntries(defined) };
}
