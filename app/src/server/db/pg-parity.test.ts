import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, describe, expect, it } from 'vitest';

// app/src/server/db/pg-parity.test.ts → app/
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('postgres schema parity (drizzle-kit generate)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-pg-parity-'));

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('generates postgres DDL from the shared schema without a live PG', () => {
    // drizzle-kit 0.31: `generate --dialect <dialect>`; exit 0 = schema compiles for pg
    const res = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      [
        'drizzle-kit',
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        path.join(appDir, 'src/server/db/schema.ts'),
        '--out',
        outDir,
      ],
      { cwd: appDir, encoding: 'utf8', timeout: 120_000 },
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    const sqlFiles = fs.readdirSync(outDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);
    const ddl = sqlFiles.map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');
    // all seven tables make it into the generated DDL
    for (const table of [
      'players',
      'ships',
      'cargo_items',
      'sessions',
      'resource_node_state',
      'system_registry',
      'deposits',
    ]) {
      expect(ddl, `missing table ${table}`).toContain(table);
    }
  }, 180_000);
});
