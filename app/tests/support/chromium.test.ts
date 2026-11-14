import { describe, expect, it } from 'vitest';
import { resolveChromiumPath, type ChromiumDeps } from './chromium.ts';

/** Builds fake deps over an in-memory set of existing paths and directory listings. */
function fakeDeps(
  files: string[],
  overrides: Partial<ChromiumDeps> = {},
  dirs: Record<string, string[]> = {},
): ChromiumDeps {
  return {
    env: {},
    expectedPath: '/b/chromium-1255/chrome-linux64/chrome',
    exists: (file) => files.includes(file) || file in dirs,
    listDir: (dir) => dirs[dir] ?? [],
    homeDir: '/home/u',
    ...overrides,
  };
}

describe('resolveChromiumPath', () => {
  it('prefers DRIFT_CHROMIUM_PATH', () => {
    const deps = fakeDeps(['/custom/chrome', '/b/chromium-1255/chrome-linux64/chrome'], {
      env: { DRIFT_CHROMIUM_PATH: '/custom/chrome' },
    });
    expect(resolveChromiumPath(deps)).toBe('/custom/chrome');
  });

  it('errors when DRIFT_CHROMIUM_PATH points nowhere', () => {
    const deps = fakeDeps([], { env: { DRIFT_CHROMIUM_PATH: '/nope' } });
    expect(() => resolveChromiumPath(deps)).toThrow(/DRIFT_CHROMIUM_PATH does not exist/);
  });

  it('uses the expected revision when installed', () => {
    const deps = fakeDeps(['/b/chromium-1255/chrome-linux64/chrome']);
    expect(resolveChromiumPath(deps)).toBe('/b/chromium-1255/chrome-linux64/chrome');
  });

  it('falls back to the newest chromium under PLAYWRIGHT_BROWSERS_PATH', () => {
    const deps = fakeDeps(
      [
        '/opt/pw/chromium-1254/chrome-linux64/chrome',
        '/opt/pw/chromium-980/chrome-linux/chrome',
        '/opt/pw/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell',
      ],
      { env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' } },
      { '/opt/pw': ['chromium_headless_shell-1300', 'chromium-980', 'chromium-1254', 'ffmpeg-1'] },
    );
    expect(resolveChromiumPath(deps)).toBe('/opt/pw/chromium-1254/chrome-linux64/chrome');
  });

  it('falls back to ~/.cache/ms-playwright when no browsers path is set', () => {
    const dir = '/home/u/.cache/ms-playwright';
    const deps = fakeDeps([`${dir}/chromium-7/chrome-linux/chrome`], {}, { [dir]: ['chromium-7'] });
    expect(resolveChromiumPath(deps)).toBe(`${dir}/chromium-7/chrome-linux/chrome`);
  });

  it('throws an actionable error when nothing is installed', () => {
    expect(() => resolveChromiumPath(fakeDeps([]))).toThrow(/playwright install chromium/);
  });
});
