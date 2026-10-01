import React from 'react';

import { dockedIndicator, dockedIndicatorSubscribe } from '@client/state/docked';

/**
 * DOCKED indicator (TASK-29.3) — the single #docked-indicator DOM node: a
 * small monospace HUD stub shown while the player's ship is server-docked.
 *
 * Driven from the session's self entity_update handler (state/docked) and
 * purely cosmetic — the full ship HUD is TASK-51. Returns null (unmounted,
 * zero cost) whenever the ship is not docked, same idiom as ReentryTint.
 */

function useDocked(): boolean {
  const [docked, setDocked] = React.useState(dockedIndicator);
  React.useEffect(() => dockedIndicatorSubscribe(setDocked), []);
  return docked;
}

const base: React.CSSProperties = {
  position: 'fixed',
  bottom: '2rem',
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '0.3rem 0.9rem',
  border: '1px solid #2a3346',
  borderRadius: 6,
  background: 'rgba(17, 21, 31, 0.85)',
  color: '#67e8f9',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.75rem',
  letterSpacing: '0.12em',
  pointerEvents: 'none',
  zIndex: 85, // above the canvas (0) + re-entry tint (80); below the star chart (90)
};

export function DockedIndicator(): React.ReactElement | null {
  const docked = useDocked();
  if (!docked) return null;
  return (
    <div id="docked-indicator" role="status" style={base}>
      DOCKED
    </div>
  );
}
