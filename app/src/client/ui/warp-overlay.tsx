import React from 'react';

import {
  warpPhase,
  warpPhaseSubscribe,
  WARP_IN_MS,
  WARP_OUT_MS,
  type WarpPhase,
} from '@client/state/warp';
import { useReducedMotion } from '@client/a11y/use-reduced-motion';

/**
 * The in-world warp transition overlay (TASK-8) — CSS only, no
 * post-processing stack in v1 (spec: "pick the cheap one").
 *
 * Rendered while the warp is in flight: a full-screen radial streak layer +
 * a bright core, over the STILL RENDERING canvas (the world never clears —
 * that is what makes the transition a rendered 2 s warp, not a loading
 * screen). The canvas gets a small camera shake (CSS transform) during the
 * warp-in half.
 *
 * Fade choreography is driven by the warp PHASE (the network wait sits
 * between the two fades, so a single fixed-duration animation cannot be
 * used):
 * - warping-in : fade 0 → 1 over the 2 s warp-in
 * - awaiting   : hold at 1 (the world swap happens under the peak)
 * - warp-out   : fade 1 → 0 over the 2 s warp-out (new system reveals)
 * - idle       : unmounted
 */

function useWarpPhaseState(): { phase: WarpPhase; shaking: boolean } {
  const [phase, setPhase] = React.useState<WarpPhase>(warpPhase);
  React.useEffect(() => warpPhaseSubscribe(setPhase), []);
  return { phase, shaking: phase === 'warping-in' };
}

const PHASE_STYLE: Record<Exclude<WarpPhase, 'idle'>, React.CSSProperties> = {
  'warping-in': { opacity: 1, animation: `warp-fade-in ${WARP_IN_MS}ms linear forwards` },
  awaiting: { opacity: 1 },
  'warp-out': { opacity: 0, animation: `warp-fade-out ${WARP_OUT_MS}ms linear forwards` },
};

export function WarpOverlay(): React.ReactElement | null {
  const { phase, shaking } = useWarpPhaseState();
  const reduced = useReducedMotion();
  React.useEffect(() => {
    const canvas = document.getElementById('game-canvas');
    // TASK-54: reduced motion drops the camera shake, too.
    if (canvas instanceof HTMLElement) canvas.classList.toggle('warp-shake', shaking && !reduced);
    return () => {
      if (canvas instanceof HTMLElement) canvas.classList.remove('warp-shake');
    };
  }, [shaking, reduced]);
  if (phase === 'idle') return null;
  if (reduced) {
    // TASK-54: reduced motion — a SIMPLE FADE veil (the phase-driven
    // opacity choreography) instead of the spinning streak + core FX.
    return (
      <div
        id="warp-overlay"
        data-reduced-motion="true"
        style={{ ...overlayBase, ...PHASE_STYLE[phase], background: '#05070c' }}
        aria-hidden="true"
      >
        <style>{css}</style>
      </div>
    );
  }
  return (
    <div id="warp-overlay" style={{ ...overlayBase, ...PHASE_STYLE[phase] }} aria-hidden="true">
      <style>{css}</style>
      <div className="warp-streaks" />
      <div className="warp-core" />
    </div>
  );
}

const overlayBase: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 80, // above the canvas, below the star chart panel (90)
  overflow: 'hidden',
};

const css = `
@keyframes warp-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes warp-fade-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}
@keyframes warp-spin {
  from { transform: scale(2.2) rotate(0deg); }
  to   { transform: scale(2.2) rotate(360deg); }
}
@keyframes warp-shake {
  0%   { transform: translate(0, 0); }
  25%  { transform: translate(1.5px, -1px); }
  50%  { transform: translate(-1px, 1.5px); }
  75%  { transform: translate(1px, 1px); }
  100% { transform: translate(-1.5px, -1px); }
}
#warp-overlay .warp-streaks {
  position: absolute;
  inset: -50%;
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    rgba(150, 195, 255, 0) 0deg,
    rgba(150, 195, 255, 0.5) 0.5deg,
    rgba(150, 195, 255, 0) 1.4deg);
  mix-blend-mode: screen;
  animation: warp-spin 1.1s linear infinite;
}
#warp-overlay .warp-core {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 50%,
    rgba(215, 238, 255, 0.95) 0%,
    rgba(140, 185, 255, 0.4) 22%,
    rgba(80, 120, 220, 0.12) 45%,
    rgba(0, 0, 0, 0) 65%);
}
#game-canvas.warp-shake {
  animation: warp-shake 120ms linear infinite;
}
`;
