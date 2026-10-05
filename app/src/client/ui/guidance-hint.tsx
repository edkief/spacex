import React from 'react';

import {
  GUIDANCE_TEXTS,
  guidanceEvent,
  guidanceState,
  guidanceSubscribe,
  guidanceVisibleStep,
} from './guidance';

/**
 * TASK-56: the first-launch hint line — bottom-center, ABOVE the prompt
 * line (the on-foot interaction line sits at 4.5 rem). Visible for the
 * first five minutes of a page load (or until X dismisses it, or the
 * finale plays out): the current guidance step's text + a small dismiss
 * tag. Pure presentation — the machine + persistence live in guidance.ts.
 */

/** The hint line's first-5-minutes window (per page load). */
export const GUIDANCE_WINDOW_MS = 5 * 60_000;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Re-render tick while the line is up (finale auto-hide + window expiry). */
const TICK_MS = 250;

export function GuidanceHint(): React.ReactElement | null {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  /** When the line first showed this page load (the 5-min window start). */
  const startedAtRef = React.useRef<number | null>(null);

  React.useEffect(() => guidanceSubscribe(force), []);
  React.useEffect(() => {
    const id = setInterval(force, TICK_MS);
    return () => clearInterval(id);
  }, []);
  // X dismisses the guidance entirely (never while typing in an input).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'x' && e.key !== 'X') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      guidanceEvent('dismiss');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const now = Date.now();
  const step = guidanceVisibleStep(guidanceState(), now);
  if (step === null) return null;
  if (startedAtRef.current === null) startedAtRef.current = now;
  if (now - startedAtRef.current >= GUIDANCE_WINDOW_MS) return null;

  return (
    <div
      id="guidance-hint"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '7.5rem', // above the interaction line (4.5 rem)
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 12,
        alignItems: 'baseline',
        padding: '6px 14px',
        border: '1px solid rgba(125, 211, 252, 0.35)',
        borderRadius: 6,
        background: 'rgba(8, 12, 18, 0.85)',
        color: '#e2e8f0',
        fontFamily: MONO,
        fontSize: 13,
        zIndex: 80,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <span id="guidance-hint-text">{GUIDANCE_TEXTS[step]}</span>
      <span style={{ color: '#64748b', fontSize: 11 }}>X — dismiss</span>
    </div>
  );
}
