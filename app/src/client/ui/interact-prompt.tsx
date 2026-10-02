import React from 'react';

/**
 * The on-foot interaction prompt (TASK-33) — the bottom-center '[E] …'
 * affordance. Rendered exactly while the per-frame interaction raycast has a
 * target (main.tsx drives the text through the prompt state machine); null
 * (zero cost) when nothing is in range.
 *
 * Purely cosmetic: the E key press dispatches through the InteractableRegistry
 * in the session (main.tsx) — the registry is the only dispatch site. Same
 * idiom as LeaveShipPrompt (fixed, pointer-events none, bottom-center).
 */
const base: React.CSSProperties = {
  position: 'fixed',
  bottom: '4.5rem', // the prompt line (LeaveShipPrompt sits at the same spot —
  // the two never show at once: that one needs a DOCKED ship, this one
  // needs an on-foot player with a target in range)
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
  whiteSpace: 'nowrap',
};

export function InteractPrompt({ text }: { text: string | null }): React.ReactElement | null {
  if (!text) return null;
  return (
    <div id="interact-prompt" role="status" style={base}>
      {text}
    </div>
  );
}
