import { beforeEach, describe, expect, it } from 'vitest';

import {
  WarpController,
  warpPhase,
  warpPhaseSubscribe,
  warpSubscribe,
  WARP_AWAIT_TIMEOUT_MS,
  __resetWarpState,
  type WarpEvent,
} from './warp';
import { WarpRejectedError } from '@client/net/session';

/**
 * TASK-8 warp state machine (spec step 3):
 *   idle → warping-in → awaiting (network) → warp-out → idle
 *   failure (rejection / timeout) → idle + onFailed (toast)
 * Timers are injected, so the 2 s phases are zero-duration in tests.
 */

/** Collects phase transitions; the first call delivers the current phase. */
function trackPhases(): string[] {
  const phases: string[] = [];
  warpPhaseSubscribe((p) => phases.push(p));
  return phases;
}

function makeController(opts: {
  requestWarp: (to: string) => Promise<unknown>;
  delay?: (ms: number) => Promise<void>;
  awaitingTimeoutMs?: number;
}): {
  controller: WarpController;
  requests: string[];
  arrivals: string[];
  failures: string[];
  events: WarpEvent[];
} {
  const requests: string[] = [];
  const arrivals: string[] = [];
  const failures: string[] = [];
  const events: WarpEvent[] = [];
  warpSubscribe((e) => events.push(e));
  const controller = new WarpController({
    requestWarp: (to) => {
      requests.push(to);
      return opts.requestWarp(to);
    },
    onArrived: (to) => arrivals.push(to),
    onFailed: (reason) => failures.push(reason),
    delay: opts.delay,
    awaitingTimeoutMs: opts.awaitingTimeoutMs,
  });
  return { controller, requests, arrivals, failures, events };
}

/** A delay that hangs until released — holds the flow in a given phase. */
function gatedDelay(): { delay: (ms: number) => Promise<void>; releaseAll: () => void } {
  const pending: Array<() => void> = [];
  return {
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        void ms;
        pending.push(resolve);
      }),
    releaseAll: () => {
      for (const r of pending.splice(0)) r();
    },
  };
}

const instant = (): Promise<void> => Promise.resolve();
/**
 * Phase delays are instant, but the timeout arm (10 s) NEVER fires — with
 * one shared instant delay the timeout's microtask would queue first and
 * win every race. Tests that WANT the timeout use `instant` instead.
 */
const phaseOnly = (ms: number): Promise<void> =>
  ms >= WARP_AWAIT_TIMEOUT_MS ? new Promise(() => {}) : Promise.resolve();
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const flush = async (turns = 10): Promise<void> => {
  for (let i = 0; i < turns; i++) await tick();
};

beforeEach(() => {
  __resetWarpState();
});

describe('WarpController (TASK-8 step 3)', () => {
  it('happy path: warping-in → awaiting → warp-out → idle, one request, one arrival', async () => {
    const phases = trackPhases();
    const { controller, requests, arrivals, failures, events } = makeController({
      requestWarp: async () => ({}),
      delay: phaseOnly,
    });

    expect(controller.start('sys-a', 'sys-b', 12)).toBe(true);
    await flush();

    expect(phases).toEqual(['idle', 'warping-in', 'awaiting', 'warp-out', 'idle']);
    expect(warpPhase()).toBe('idle');
    expect(controller.phase).toBe('idle');
    expect(controller.targetSystemId).toBeNull();
    expect(requests).toEqual(['sys-b']);
    expect(arrivals).toEqual(['sys-b']);
    expect(failures).toEqual([]);
    expect(events).toEqual([
      { type: 'warp-started', fromSystemId: 'sys-a', toSystemId: 'sys-b', etaSeconds: 12 },
      { type: 'warp-complete', toSystemId: 'sys-b' },
    ]);
  });

  it('cannot be started twice: a second start while in flight returns false', async () => {
    const gate = gatedDelay();
    const { controller, arrivals } = makeController({
      requestWarp: async () => ({}),
      delay: gate.delay,
    });

    expect(controller.start('sys-a', 'sys-b', 10)).toBe(true);
    // Held in warping-in: a second start (any destination) is refused…
    expect(controller.start('sys-a', 'sys-c', 10)).toBe(false);
    expect(controller.phase).toBe('warping-in');
    // …and a warp to the current system is refused outright.
    expect(controller.start('sys-b', 'sys-b', 10)).toBe(false);

    gate.releaseAll();
    await tick(); // warping-in → awaiting (request settles on the next turn)
    gate.releaseAll();
    await tick();
    gate.releaseAll();
    await tick(); // warp-out → idle
    expect(controller.phase).toBe('idle');
    expect(arrivals).toEqual(['sys-b']);
    // After completion the controller can warp again.
    expect(controller.start('sys-b', 'sys-c', 10)).toBe(true);
  });

  it('server rejection (system full) → idle + warp-failed + the "System full" toast text', async () => {
    const phases = trackPhases();
    const { controller, failures, events } = makeController({
      requestWarp: () =>
        Promise.reject(new WarpRejectedError('system-full', 'system sys-b is full (16 players)')),
      delay: phaseOnly,
    });

    expect(controller.start('sys-a', 'sys-b', 10)).toBe(true);
    await flush();

    expect(phases).toEqual(['idle', 'warping-in', 'awaiting', 'idle']);
    expect(controller.phase).toBe('idle');
    expect(controller.targetSystemId).toBeNull();
    expect(failures).toEqual(['System full']);
    expect(events).toEqual([
      { type: 'warp-started', fromSystemId: 'sys-a', toSystemId: 'sys-b', etaSeconds: 10 },
      { type: 'warp-failed', toSystemId: 'sys-b' },
    ]);
  });

  it('other rejections surface the server message as the failure reason', async () => {
    const { controller, failures, events } = makeController({
      requestWarp: () =>
        Promise.reject(new WarpRejectedError('system-not-found', 'system ffffffff not found')),
      delay: phaseOnly,
    });

    expect(controller.start('sys-a', 'sys-b', 10)).toBe(true);
    await flush();

    expect(controller.phase).toBe('idle');
    expect(failures).toEqual(['Warp failed: system ffffffff not found']);
    expect(events.some((e) => e.type === 'warp-failed')).toBe(true);
  });

  it('awaiting timeout: a server that never answers fails the warp', async () => {
    // The timeout arm (delay(awaitingTimeoutMs)) wins the race against the
    // never-settling request → the warp fails and rolls back to idle.
    const { controller, failures, events } = makeController({
      requestWarp: () => new Promise(() => {}), // the server never responds
      delay: instant,
      awaitingTimeoutMs: 1,
    });

    expect(controller.start('sys-a', 'sys-b', 10)).toBe(true);
    await flush();

    expect(controller.phase).toBe('idle');
    expect(controller.targetSystemId).toBeNull();
    expect(failures).toEqual(['Warp failed: warp timed out']);
    expect(events.some((e) => e.type === 'warp-failed')).toBe(true);
  });

  it('abort() abandons an in-flight warp without arriving', async () => {
    const gate = gatedDelay();
    const { controller, arrivals, events } = makeController({
      requestWarp: async () => ({}),
      delay: gate.delay,
    });

    expect(controller.start('sys-a', 'sys-b', 10)).toBe(true);
    controller.abort();
    expect(controller.phase).toBe('idle');
    expect(controller.targetSystemId).toBeNull();
    expect(events.some((e) => e.type === 'warp-failed')).toBe(true);

    // Even when the held phases finally resolve, the flow must stay dead.
    gate.releaseAll();
    await flush();
    expect(arrivals).toEqual([]);
    expect(controller.phase).toBe('idle');
  });
});
