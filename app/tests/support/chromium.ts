import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

/** Environment access injected so the resolver can be unit-tested without a real browser. */
export interface ChromiumDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Path Playwright expects for the installed revision. */
  expectedPath: string;
  exists: (file: string) => boolean;
  listDir: (dir: string) => string[];
  homeDir: string;
}

/**
 * Finds the newest `chromium-<rev>/chrome-linux64/chrome` (or `chrome-linux/chrome`) under the
 * browsers directory, ignoring headless-shell and other browsers.
 */
export function findNewestChromium(browsersDir: string, deps: ChromiumDeps): string | undefined {
  if (!deps.exists(browsersDir)) return undefined;
  const revisions = deps
    .listDir(browsersDir)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const match of revisions) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const candidate = path.join(browsersDir, match[0], sub, 'chrome');
      if (deps.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Picks the Chromium executable for e2e: DRIFT_CHROMIUM_PATH (must exist), else the revision
 * Playwright expects, else the newest chromium under PLAYWRIGHT_BROWSERS_PATH.
 * @throws with an actionable message when nothing is found.
 */
export function resolveChromiumPath(deps: ChromiumDeps): string {
  const override = deps.env['DRIFT_CHROMIUM_PATH'];
  if (override) {
    if (!deps.exists(override)) throw new Error(`DRIFT_CHROMIUM_PATH does not exist: ${override}`);
    return override;
  }
  if (deps.exists(deps.expectedPath)) return deps.expectedPath;

  const configured = deps.env['PLAYWRIGHT_BROWSERS_PATH'];
  const browsersDir =
    configured && configured !== '0'
      ? configured
      : path.join(deps.homeDir, '.cache', 'ms-playwright');
  const fallback = findNewestChromium(browsersDir, deps);
  if (fallback) return fallback;

  throw new Error(
    `No Chromium found. Expected ${deps.expectedPath}; nothing under ${browsersDir}. ` +
      'Run `npx playwright install chromium` or set DRIFT_CHROMIUM_PATH.',
  );
}

/** Resolves the Chromium executable using the real filesystem and Playwright's expected path. */
export function resolveChromiumFromSystem(): string {
  return resolveChromiumPath({
    env: process.env,
    expectedPath: chromium.executablePath(),
    exists: existsSync,
    listDir: (dir) => readdirSync(dir),
    homeDir: os.homedir(),
  });
}
