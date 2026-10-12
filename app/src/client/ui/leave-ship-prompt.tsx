import React from 'react';

import { dockedIndicator, dockedIndicatorSubscribe } from '@client/state/docked';
import { canExitShip, canExitShipSubscribe } from '@client/state/exit-ship';

/**
 * "E — LEAVE SHIP" prompt (TASK-31, TASK-105) — the disembark entry point.
 * Bottom-center above the DOCKED indicator, visible while the player's OWN
 * ship is PAD-DOCKED (the state/docked store that drives #docked-indicator)
 * OR LANDED on the surface off-pad (the state/exit-ship store — the DOCKED
 * indicator is hidden there, the prompt carries the affordance). After
 * disembark the player's self entity is the character, both stores go false,
 * and the prompt disappears with them. "LEAVE SHIP" reads accurately in both
 * states (leaving a docked ship and leaving a landed ship).
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

function useCanExit(): boolean {
  const [canExit, setCanExit] = React.useState(canExitShip);
  React.useEffect(() => canExitShipSubscribe(setCanExit), []);
  return canExit;
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
  const canExit = useCanExit();
  if (!docked && !canExit) return null;
  return (
    <div id="leave-ship-prompt" role="status" style={base}>
      <span style={keyCap}>E</span>
      LEAVE SHIP
    </div>
  );
}
