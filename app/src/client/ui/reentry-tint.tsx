import React from 'react';

import { reentryTint, reentryTintSubscribe } from '@client/state/reentry';

/**
 * Re-entry tint overlay (TASK-28.2) — the cosmetic orange rim ramp (CSS
 * only, no post-processing). A fixed full-screen radial-gradient overlay
 * above the canvas whose `opacity` is the live tint value in
 * [0, REENTRY_TINT_MAX = 0.4] (kept subtle by design).
 *
 * Purely cosmetic: it is DRIVEN by the session's self entity_update
 * handler (reentryTintFactor on -vel.y × boundary) and never feeds physics.
 * Returns null when the tint is 0 (unmounted, zero cost in space /
 * slow flight).
 */

function useReentryTint(): number {
  const [tint, setTint] = React.useState(reentryTint);
  React.useEffect(() => reentryTintSubscribe(setTint), []);
  return tint;
}

const base: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 80, // above the canvas, below the star chart panel (90) — same layer as the warp overlay
  overflow: 'hidden',
  // Orange rim: clear in the center, saturated at the screen edge.
  background:
    'radial-gradient(ellipse at center, rgba(255,120,30,0) 55%, rgba(255,120,30,0.9) 100%)',
};

export function ReentryTint(): React.ReactElement | null {
  const tint = useReentryTint();
  if (tint <= 0) return null;
  return <div id="reentry-tint" aria-hidden="true" style={{ ...base, opacity: tint }} />;
}
