// @vitest-environment happy-dom
/**
 * TASK-56: the guidance hint line — the presentation over the machine.
 *
 * Covers: the current step's text renders bottom-center ABOVE the prompt
 * line, X dismisses (and never while typing), the finale auto-hides after
 * 5 s, and the line never shows past its 5-minute window.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GUIDANCE_FINALE_MS, guidanceEvent, guidanceState, __resetGuidance } from './guidance';
import { GUIDANCE_WINDOW_MS, GuidanceHint } from './guidance-hint';

let roots: Root[] = [];

function renderHint(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<GuidanceHint />);
  });
  roots.push(root);
  return container;
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await null;
  });
}

beforeEach(() => {
  __resetGuidance();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('GuidanceHint', () => {
  it('renders step 1 bottom-center, above the interaction line (4.5 rem)', () => {
    const el = renderHint();
    const hint = el.querySelector('#guidance-hint');
    expect(hint).not.toBeNull();
    // TASK-82: step 1 no longer says "fly toward the star" — it points the
    // player at the nav marker (the star is now a distant sun, −X).
    expect(hint?.textContent).toContain('Hold W to fly');
    expect(hint?.textContent).toContain('nav marker');
    expect(hint?.textContent).not.toContain('toward the star');
    expect(hint?.textContent).toContain('X — dismiss');
    const style = getComputedStyle(hint!);
    expect(style.position).toBe('fixed');
    expect((hint as HTMLElement).style.bottom).toBe('7.5rem'); // above the 4.5 rem prompt
  });

  it('shows the furthest step after events (the machine drives the line)', async () => {
    const el = renderHint();
    act(() => {
      guidanceEvent('disembark');
    });
    expect(el.querySelector('#guidance-hint-text')?.textContent).toBe(
      'Press E at a docked ship to go on foot. Find an ore deposit.',
    );
    act(() => {
      guidanceEvent('pickup');
    });
    expect(el.querySelector('#guidance-hint-text')?.textContent).toContain('dock terminal');
  });

  it('X dismisses the line (and persists 4); typing X does not', async () => {
    const el = renderHint();
    // X while typing in an input is ignored (the event's target is the input).
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    });
    expect(el.querySelector('#guidance-hint')).not.toBeNull();
    // X on the document dismisses.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true }));
    });
    expect(el.querySelector('#guidance-hint')).toBeNull();
    expect(guidanceState().dismissed).toBe(true);
    expect(localStorage.getItem('drift.guidance')).toBe('4');
  });

  it('the finale (first sale) auto-hides after 5 s', async () => {
    const el = renderHint();
    act(() => {
      guidanceEvent('sale');
    });
    expect(el.querySelector('#guidance-hint-text')?.textContent).toBe(
      'You are drifting. Good luck.',
    );
    await tick(GUIDANCE_FINALE_MS - 1);
    expect(el.querySelector('#guidance-hint')).not.toBeNull();
    await tick(1);
    expect(el.querySelector('#guidance-hint')).toBeNull();
  });

  it('never shows past the 5-minute window (per page load)', async () => {
    const el = renderHint();
    expect(el.querySelector('#guidance-hint')).not.toBeNull();
    await tick(GUIDANCE_WINDOW_MS);
    expect(el.querySelector('#guidance-hint')).toBeNull();
    // …and events after the window no longer bring the line back.
    act(() => {
      guidanceEvent('disembark');
    });
    await tick(0);
    expect(el.querySelector('#guidance-hint')).toBeNull();
  });
});
