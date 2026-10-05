// @vitest-environment happy-dom
/**
 * TASK-56: the first-launch guidance state machine.
 *
 * Covers: the spawn-dock edge (a dock before any flight is ignored), the
 * dock → step 2 transition, disembark → step 2, first pickup → step 3,
 * first sale → finale + 5 s auto-hide, X dismissal, and the localStorage
 * persistence (a simulated refresh resumes at the furthest step, a
 * dismissal never comes back).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  GUIDANCE_FINALE_MS,
  GUIDANCE_STORAGE_KEY,
  GUIDANCE_TEXTS,
  __resetGuidance,
  guidanceAdvance,
  guidanceEvent,
  guidanceState,
  guidanceSubscribe,
  guidanceVisibleStep,
  initialGuidance,
  loadGuidanceFurthest,
} from './guidance';

const T0 = 1_000_000;

describe('guidanceAdvance (the pure machine)', () => {
  it('starts at step 1 (index 0 = the fly-the-ship hint)', () => {
    const s = initialGuidance();
    expect(s.furthest).toBe(1);
    expect(guidanceVisibleStep(s, T0)).toBe(0);
    expect(GUIDANCE_TEXTS[0]).toContain('Hold W');
  });

  it('ignores the spawn-dock: a dock before any undock stays on step 1', () => {
    // Boot: the starter ship is docked — the first docked frame must not
    // jump the guidance to step 2.
    let s = guidanceAdvance(initialGuidance(), 'docked', T0);
    expect(s.furthest).toBe(1);
    // Fly (undock), then dock at ANY station → step 2.
    s = guidanceAdvance(s, 'undocked', T0 + 1);
    s = guidanceAdvance(s, 'docked', T0 + 2);
    expect(s.furthest).toBe(2);
    expect(guidanceVisibleStep(s, T0 + 2)).toBe(1);
    expect(GUIDANCE_TEXTS[1]).toContain('Find an ore deposit');
  });

  it('disembarking advances to step 2 (no flight needed)', () => {
    const s = guidanceAdvance(initialGuidance(), 'disembark', T0);
    expect(s.furthest).toBe(2);
  });

  it('the first pickup advances to step 3 (load + sell)', () => {
    let s = guidanceAdvance(initialGuidance(), 'disembark', T0);
    s = guidanceAdvance(s, 'pickup', T0 + 1);
    expect(s.furthest).toBe(3);
    expect(guidanceVisibleStep(s, T0 + 1)).toBe(2);
    expect(GUIDANCE_TEXTS[2]).toContain('dock terminal');
  });

  it('the first sale plays the finale, which auto-hides after 5 s', () => {
    let s = guidanceAdvance(initialGuidance(), 'sale', T0);
    expect(s.furthest).toBe(4);
    expect(s.finaleAt).toBe(T0);
    expect(guidanceVisibleStep(s, T0)).toBe(3); // 'You are drifting. Good luck.'
    expect(guidanceVisibleStep(s, T0 + GUIDANCE_FINALE_MS - 1)).toBe(3);
    expect(guidanceVisibleStep(s, T0 + GUIDANCE_FINALE_MS)).toBeNull();
  });

  it('X (dismiss) ends the guidance for good, at any step', () => {
    let s = guidanceAdvance(initialGuidance(), 'pickup', T0);
    s = guidanceAdvance(s, 'dismiss', T0 + 1);
    expect(s.dismissed).toBe(true);
    expect(guidanceVisibleStep(s, T0 + 1)).toBeNull();
    // Dismissed is terminal: later events are no-ops.
    expect(guidanceAdvance(s, 'sale', T0 + 2)).toBe(s);
  });

  it('never regresses: an earlier event after a later one is a no-op', () => {
    let s = guidanceAdvance(initialGuidance(), 'pickup', T0);
    s = guidanceAdvance(s, 'sale', T0 + 1);
    s = guidanceAdvance(s, 'docked', T0 + 2);
    expect(s.furthest).toBe(4);
    expect(s.finaleAt).toBe(T0 + 1); // the FIRST sale stamps the finale
  });

  it('is idempotent: repeating the same event changes nothing', () => {
    const s0 = initialGuidance();
    const s1 = guidanceAdvance(s0, 'undocked', T0);
    expect(guidanceAdvance(s1, 'undocked', T0 + 1)).toBe(s1);
  });
});

describe('the store + persistence (localStorage round-trip)', () => {
  beforeEach(() => {
    __resetGuidance();
  });

  it('persists the furthest step on every real change', () => {
    guidanceEvent('disembark');
    expect(localStorage.getItem(GUIDANCE_STORAGE_KEY)).toBe('2');
    guidanceEvent('pickup');
    expect(localStorage.getItem(GUIDANCE_STORAGE_KEY)).toBe('3');
    guidanceEvent('pickup'); // no-op — same value
    expect(localStorage.getItem(GUIDANCE_STORAGE_KEY)).toBe('3');
  });

  it('a simulated refresh resumes at the furthest step (not step 1)', () => {
    guidanceEvent('docked'); // ignored at spawn
    guidanceEvent('disembark'); // → 2
    // "Refresh": the module's state would be rebuilt from storage.
    const furthest = loadGuidanceFurthest();
    expect(furthest).toBe(2);
    const resumed = initialGuidance(furthest);
    expect(guidanceVisibleStep(resumed, Date.now())).toBe(1); // step 2 text
  });

  it('a dismissal persists 4 and never comes back after a refresh', () => {
    guidanceEvent('pickup');
    guidanceEvent('dismiss');
    expect(localStorage.getItem(GUIDANCE_STORAGE_KEY)).toBe('4');
    const resumed = initialGuidance(loadGuidanceFurthest());
    expect(resumed.dismissed).toBe(true);
    expect(guidanceVisibleStep(resumed, Date.now())).toBeNull();
  });

  it('corrupt/absent storage falls back to step 1', () => {
    expect(loadGuidanceFurthest()).toBe(1);
    localStorage.setItem(GUIDANCE_STORAGE_KEY, 'banana');
    expect(loadGuidanceFurthest()).toBe(1);
    localStorage.setItem(GUIDANCE_STORAGE_KEY, '99');
    expect(loadGuidanceFurthest()).toBe(1);
  });

  it('emits only on real change (late subscribers catch up)', () => {
    const seen: unknown[] = [];
    const unsub = guidanceSubscribe(() => seen.push(guidanceState().furthest));
    expect(seen).toEqual([1]); // immediate catch-up
    guidanceEvent('docked'); // spawn-dock: no change
    expect(seen).toEqual([1]);
    guidanceEvent('disembark');
    expect(seen).toEqual([1, 2]);
    unsub();
    guidanceEvent('pickup');
    expect(seen).toEqual([1, 2]);
  });
});
