/**
 * React binding for the reduced-motion setting (TASK-54): components
 * re-render the instant the toggle flips (no restart) — the threat ping
 * swaps to its static icon and the warp overlay drops to a plain fade.
 */
import React from 'react';
import { isReducedMotion, settingsSubscribe } from './reduced-motion';

export function useReducedMotion(): boolean {
  const [on, setOn] = React.useState(isReducedMotion());
  React.useEffect(
    () =>
      settingsSubscribe((s) => {
        setOn(s['reduced-motion']);
      }),
    [],
  );
  return on;
}
