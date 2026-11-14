import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAppDir, loadAppEnv, resolveProjectRoot } from '@server/env';

describe('env loading', () => {
  let root: string;
  let appDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drift-env-'));
    appDir = path.join(root, 'app');
    mkdirSync(path.join(appDir, 'src', 'server'), { recursive: true });
    writeFileSync(path.join(appDir, 'package.json'), '{}');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the app dir from nested directories', () => {
    expect(findAppDir(path.join(appDir, 'src', 'server'))).toBe(appDir);
  });

  it('defaults PROJECT_ROOT to the parent of the app dir, honouring an override', () => {
    expect(resolveProjectRoot(appDir, {})).toBe(root);
    expect(resolveProjectRoot(appDir, { PROJECT_ROOT: '/elsewhere' })).toBe('/elsewhere');
  });

  it('merges .env.local under real env vars and tolerates a missing file', () => {
    expect(loadAppEnv(appDir, {})).toEqual({});
    writeFileSync(path.join(root, '.env.local'), 'PORT=4000\nGALAXY_SEED=from-file\n');
    const env = loadAppEnv(appDir, { PORT: '5000', UNSET: undefined });
    expect(env).toEqual({ PORT: '5000', GALAXY_SEED: 'from-file' });
  });
});
