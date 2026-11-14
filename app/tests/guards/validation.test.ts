import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER = path.join(import.meta.dirname, '../../src/server');

/** Non-test, non-testing source files under `dir`. */
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'testing' ? [] : sources(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

describe('validation audit', () => {
  const files = sources(SERVER);

  it('never parses JSON or reads raw message data outside the shared protocol layer', () => {
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code.includes('JSON.parse'), `${file} calls JSON.parse`).toBe(false);
    }
  });

  it('routes every WebSocket text frame through the single dispatcher', () => {
    const wsIndex = readFileSync(path.join(SERVER, 'ws/index.ts'), 'utf8');
    expect(wsIndex.match(/dispatch\(/g)?.length).toBe(1);
    const others = files.filter(
      (f) =>
        !f.endsWith(path.join('ws', 'dispatch.ts')) && !f.endsWith(path.join('ws', 'index.ts')),
    );
    for (const file of others) {
      const code = readFileSync(file, 'utf8');
      expect(code.includes('parseClientMessage'), `${file} parses client messages itself`).toBe(
        false,
      );
      expect(code.includes("on('message'"), `${file} listens to raw messages`).toBe(false);
    }
  });
});
