/**
 * Dev-only determinism debug hook (TASK-71).
 *
 * Exposes `window.__DRIFT__` on the page so the two-client e2e test can pull
 * the client-derived galaxy data (star chart + a system's planet list) and
 * compare two independent contexts for equality (SC-2). The hook derives
 * everything from the SERVER-provided seed (GALAXY_SEED, via /api/health),
 * so it exercises the real client derivation path — not a parallel copy.
 *
 * It is only installed when `import.meta.env.DEV` is true, so production
 * builds (vite build) never ship it.
 */

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import type { Star, SystemGen } from '@shared/galaxy/types';

/** Shape of the debug surface the e2e tests read. */
export interface DriftDebug {
  /** True once the server seed from /api/health has arrived. */
  ready: boolean;
  /** GALAXY_SEED exactly as /api/health exposes it (client-side copy). */
  seed: string | null;
  /** Deterministic star chart derived from the server seed. */
  starChart(count?: number): Star[];
  /** Deterministic system (planet list) for a star id, from the server seed. */
  planetList(starId: string): SystemGen;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __DRIFT__?: DriftDebug;
  }
}

/**
 * Install the hook on window. No-op in production builds (DEV flag false).
 * Called once at module load from main.tsx.
 */
export function installDriftDebug(): void {
  if (!import.meta.env.DEV) return;
  const hook: DriftDebug = {
    ready: false,
    seed: null,
    starChart(count = 64) {
      if (!hook.seed) throw new Error('__DRIFT__: server seed not ready');
      return generateStars(hook.seed, count);
    },
    planetList(starId: string) {
      if (!hook.seed) throw new Error('__DRIFT__: server seed not ready');
      return generateSystem(hook.seed, starId);
    },
  };
  window.__DRIFT__ = hook;
}

/** Record the server-provided seed (called by main.tsx after /api/health). */
export function reportServerSeed(seed: string): void {
  const hook = window.__DRIFT__;
  if (!hook) return;
  hook.seed = seed;
  hook.ready = true;
}
