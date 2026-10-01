import React from 'react';

import { dockedIndicator, dockedIndicatorSubscribe } from '@client/state/docked';

/**
 * "E — LEAVE SHIP" prompt (TASK-31) — the disembark entry point. Bottom-center
 * above the DOCKED indicator, visible EXACTLY while the player's OWN entity
 * is a docked ship (the same state/docked store drives #docked-indicator —
 * after disembark the player's self entity is the character, the store goes
 * false, and the prompt disappears with it).
 *
 * Purely cosmetic: the key press is handled in the session (main.tsx) — this
 * component just renders the affordance. pointer-events none, same idiom as
 * DockedIndicator (null when hidden, zero cost).
 */

function useDocked(): boolean {
  const [docked, setDocked] = React.useState(dockedIndicator);
  React.useEffect(() => dockedIndicatorSubscribe(setDocked), []);
  return docked;
}

const base: React.CSSProperties = {
  position: 'fixed',
  bottom: '4.5rem', // above #docked-indicator (2rem)
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '0.3rem 0.9rem',
  border: '1px solid #2a3346',
  borderRadius: 6,
  background: 'rgba(17, 21, 31, 0.85)',
  color: '#d6deeb',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.75rem',
  letterSpacing: '0.12em',
  pointerEvents: 'none',
  zIndex: 86,
};

const keyCap: React.CSSProperties = {
  color: '#67e8f9',
  border: '1px solid #67e8f9',
  borderRadius: 3,
  padding: '0 0.35rem',
  marginRight: '0.4rem',
};

export function LeaveShipPrompt(): React.ReactElement | null {
  const docked = useDocked();
  if (!docked) return null;
  return (
    <div id="leave-ship-prompt" role="status" style={base}>
      <span style={keyCap}>E</span>
      LEAVE SHIP
    </div>
  );
}
