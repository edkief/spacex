// @vitest-environment happy-dom
/**
 * TASK-56: the claims screen.
 *
 * Live-render tests: the validation states (format immediately, the
 * debounced 500 ms server probe → 'available' green / 'taken' red), the
 * Claim button's gating (disabled until valid AND available), the 3-step
 * intro (auto-advancing 4 s, skippable), the claim POST → onClaimed, and
 * the expired mode (the old callsign shown disabled + the recovery message).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AVAILABILITY_DEBOUNCE_MS,
  INTRO_STEP_MS,
  ClaimsScreen,
  claimStatusFor,
} from './claims-screen';

let roots: Root[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

interface ClaimedBody {
  callsign: string;
  token: string;
  playerId: string;
  homeSystemId: string;
  shipId: string;
}

/** The fetch stub: routes the availability probe + the claim POST. */
function installFetch(opts: { available: Record<string, boolean>; claimStatus?: number }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/callsigns/availability?')) {
      const callsign = new URL(url, 'http://x').searchParams.get('callsign') ?? '';
      return Response.json({ available: opts.available[callsign] ?? true });
    }
    if (url === '/api/callsigns' && init?.method === 'POST') {
      const body =
        opts.claimStatus === 409
          ? { code: 'callsign-taken', message: 'taken' }
          : {
              callsign: 'test-pilot',
              token: 'tok-1',
              playerId: 'p1',
              homeSystemId: 'abcd1234abcd1234',
              shipId: 'ship-1',
            };
      return Response.json(body, { status: opts.claimStatus ?? 201 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderClaims(props: {
  expiredCallsign?: string | null;
  onClaimed?: (s: unknown) => void;
}): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ClaimsScreen
        expiredCallsign={props.expiredCallsign ?? null}
        onClaimed={(s) => props.onClaimed?.(s)}
      />,
    );
  });
  roots.push(root);
  return container;
}

const inputOf = (el: HTMLDivElement) => el.querySelector<HTMLInputElement>('#callsign-input');
const buttonOf = (el: HTMLDivElement) => el.querySelector<HTMLButtonElement>('#claim-button');
const statusOf = (el: HTMLDivElement) => el.querySelector<HTMLElement>('#claims-status');

/** Type into the callsign input (React controlled input). */
function type(el: HTMLDivElement, value: string): void {
  act(() => {
    const input = inputOf(el)!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Advance the fake clock + flush microtasks (the probe's promise chain). */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await null;
    await null;
  });
}

beforeEach(() => {
  installFetch({ available: {} });
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('validation + claim gating', () => {
  it('starts disabled: no format, no probe, no claim', async () => {
    const el = renderClaims({});
    expect(buttonOf(el)?.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    type(el, 'ab'); // too short
    await tick(0);
    expect(statusOf(el)?.textContent).toContain('3–16 chars');
    expect(fetchMock).not.toHaveBeenCalled(); // format fails before the probe
  });

  it('the availability probe is debounced 500 ms, then the status flips', async () => {
    const el = renderClaims({});
    type(el, 'TEST-PILOT');
    await tick(AVAILABILITY_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusOf(el)?.textContent).toBe('checking…');
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusOf(el)?.textContent).toBe('available');
    expect(statusOf(el)?.style.color).toBe('#4ade80');
    expect(buttonOf(el)?.disabled).toBe(false);
  });

  it('a taken callsign: red status + the claim stays disabled', async () => {
    installFetch({ available: { 'taken-cs': false } });
    const el = renderClaims({});
    type(el, 'taken-cs');
    await tick(AVAILABILITY_DEBOUNCE_MS);
    expect(statusOf(el)?.textContent).toBe('taken');
    expect(statusOf(el)?.style.color).toBe('#f87171');
    expect(buttonOf(el)?.disabled).toBe(true);
  });

  it('rapid typing collapses to ONE probe (latest value wins)', async () => {
    installFetch({ available: { 'final-one': true } });
    const el = renderClaims({});
    type(el, 'f');
    type(el, 'fi');
    type(el, 'final-one');
    await tick(AVAILABILITY_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('callsign=final-one');
  });
});

describe('the claim POST', () => {
  it('claim → POST /api/callsigns → onClaimed with the session (stored first)', async () => {
    const onClaimed = vi.fn();
    const el = renderClaims({ onClaimed });
    type(el, 'TEST-PILOT');
    await tick(AVAILABILITY_DEBOUNCE_MS);
    await act(async () => {
      buttonOf(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await null;
      await null;
    });
    expect(onClaimed).toHaveBeenCalledTimes(1);
    const session = onClaimed.mock.calls[0][0] as ClaimedBody;
    expect(session).toMatchObject({ callsign: 'test-pilot', token: 'tok-1' });
    expect(localStorage.getItem('drift.token')).toBe('tok-1');
    expect(JSON.parse(localStorage.getItem('drift.session.v1')!)).toMatchObject({
      token: 'tok-1',
      callsign: 'test-pilot',
    });
  });

  it('a 409 (someone won the race) → taken status + the error line', async () => {
    installFetch({ available: { 'race-cs': true }, claimStatus: 409 });
    const el = renderClaims({});
    type(el, 'race-cs');
    await tick(AVAILABILITY_DEBOUNCE_MS);
    await act(async () => {
      buttonOf(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await null;
      await null;
    });
    expect(statusOf(el)?.textContent).toBe('taken');
    expect(el.querySelector('form [role="alert"]')?.textContent).toContain('already taken');
    expect(localStorage.getItem('drift.token')).toBeNull();
  });
});

describe('the 3-step intro', () => {
  it('auto-advances 4 s per step and stops at the last', async () => {
    const el = renderClaims({});
    expect(el.querySelector('#claims-intro-text')?.textContent).toBe(
      'This is a living galaxy. Every system is real.',
    );
    await tick(INTRO_STEP_MS);
    expect(el.querySelector('#claims-intro-text')?.textContent).toBe(
      'Fly. Land. Go on foot. No loading screens.',
    );
    await tick(INTRO_STEP_MS);
    expect(el.querySelector('#claims-intro-text')?.textContent).toBe('Mine. Haul. Sell. Survive.');
    await tick(INTRO_STEP_MS * 3); // it does not loop
    expect(el.querySelector('#claims-intro-text')?.textContent).toBe('Mine. Haul. Sell. Survive.');
  });

  it('is skippable: SKIP removes it', async () => {
    const el = renderClaims({});
    act(() => {
      el.querySelector<HTMLButtonElement>('#claims-skip')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(el.querySelector('#claims-intro')).toBeNull();
  });
});

describe('the expired mode', () => {
  it('shows the message + the old callsign prefilled and DISABLED', async () => {
    const el = renderClaims({ expiredCallsign: 'old-pilot' });
    expect(el.querySelector('#claims-expired')?.textContent).toBe(
      'Your session expired. Claim a new callsign.',
    );
    const input = inputOf(el)!;
    expect(input.value).toBe('old-pilot');
    expect(input.disabled).toBe(true);
    expect(buttonOf(el)?.disabled).toBe(true);
    // No availability probe for a disabled claim.
    await tick(AVAILABILITY_DEBOUNCE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('claimStatusFor (the pure mapping)', () => {
  it('maps every state to its line + color', () => {
    expect(claimStatusFor('available', false)).toEqual({
      text: 'available',
      color: '#4ade80',
    });
    expect(claimStatusFor('taken', false)).toEqual({ text: 'taken', color: '#f87171' });
    expect(claimStatusFor('checking', false)?.text).toBe('checking…');
    expect(claimStatusFor('invalid', false)?.text).toContain('3–16 chars');
    expect(claimStatusFor('idle', false)).toBeNull();
    expect(claimStatusFor('idle', true)?.text).toContain('session expired');
  });
});
