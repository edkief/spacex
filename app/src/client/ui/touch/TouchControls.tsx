/**
 * TouchControls (TASK-91, PRD §4.13 / SC-6) — the FLIGHT touch layout.
 *
 * Owns the on-screen arrangement of the two TouchJoysticks + the per-regime
 * TouchButton and feeds every gesture into the SHARED TouchInputSource
 * (main.tsx keeps ownership of the ref; the source is a prop). The virtual
 * keys the source projects are merged into the pressed set the ship loop
 * already reads (TASK-89) — nothing downstream changes.
 *
 * Mapping (up-positive y from TASK-90):
 * - LEFT stick: thrust (up/down) + yaw (left/right) — `thrust: y, yaw: x`.
 * - RIGHT stick: pitch (up/down) + roll (left/right) — `pitch: y, roll: x`.
 * - VTOL button: atmosphere ONLY (the ' ' channel — same key as jump).
 * - BOOST button: space ONLY (the 'Shift' channel — same key as run).
 *
 * Regime gating mirrors the ControlScheme exactly: on the SURFACE the
 * on-foot layout (TASK-93) owns the corners, so this container renders
 * nothing there — and clears the flight channels it would otherwise leave
 * held (a button unmounted mid-press never fires onRelease).
 *
 * When `enabled` is false (the feature is off — TASK-94's flag; v1 gates on
 * a touch-capable device) the container renders nothing and the channels
 * stay empty: the merge in TASK-89 is a no-op.
 */
import React from 'react';

import type { TouchInputSource } from '@client/input/touch';
import type { Regime } from '@shared/regime';

import { TouchButton } from './TouchButton';
import { TouchJoystick, type TouchVector } from './TouchJoystick';

export interface TouchControlsProps {
  /** The feature-enable state (false = render nothing, channels stay off). */
  enabled: boolean;
  /** The active flight regime — gates the per-regime button (and the surface). */
  regime: Regime;
  /** The shared touch source (main.tsx owns the ref). */
  source: TouchInputSource;
}

/** Corner inset from the screen edge (on top of the safe-area inset). */
const CORNER = 24;

const side: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
};

export function TouchControls({
  enabled,
  regime,
  source,
}: TouchControlsProps): React.ReactElement | null {
  // Rules of hooks: these run before the early return below, so the
  // unmount / disabled cleanups always fire.
  // Disabled (or an unmount while enabled) clears every channel — a stale
  // held channel would keep flying the ship with no visible control.
  React.useEffect(() => {
    if (!enabled) {
      source.clear();
      return;
    }
    return () => source.clear();
  }, [enabled, source]);
  // A regime flip unmounts the outgoing regime's button mid-press (the
  // removed element's onRelease never fires) — clear its channel so the
  // deliberate key collision can't leak across regimes. The initial mount
  // writes nothing (no channel is held yet).
  const prevRegimeRef = React.useRef<Regime | null>(null);
  React.useEffect(() => {
    const prev = prevRegimeRef.current;
    prevRegimeRef.current = regime;
    if (prev === null) return;
    if (regime === 'atmosphere') source.setChannel({ boost: false });
    else if (regime === 'space') source.setChannel({ vtol: false });
    else source.clear(); // surface: the on-foot layout (TASK-93) owns the input
  }, [regime, source]);

  if (!enabled || regime === 'surface') return null;
  const atmosphere = regime === 'atmosphere';

  const onLeft = (v: TouchVector): void => source.setChannel({ thrust: v.y, yaw: v.x });
  const onRight = (v: TouchVector): void => source.setChannel({ pitch: v.y, roll: v.x });

  return (
    <div
      id="touch-controls"
      aria-label="Touch controls"
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 80 }}
    >
      {/* LEFT stick — thrust + yaw (the throttle). */}
      <div
        id="touch-stick-left"
        style={{
          ...side,
          left: `calc(${CORNER}px + env(safe-area-inset-left, 0px))`,
          bottom: `calc(${CORNER}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <TouchJoystick label="thrust and yaw stick" onChange={onLeft} />
      </div>
      {/* The per-regime button above the RIGHT stick (VTOL in atmosphere,
          BOOST in space — the same physical slot, the regime decides).
          Right side by design: the left edge carries the ship HUD +
          player list, and the right mid-screen is the clear zone. */}
      <div
        id={atmosphere ? 'touch-btn-vtol' : 'touch-btn-boost'}
        style={{
          ...side,
          right: `calc(${CORNER + 32}px + env(safe-area-inset-right, 0px))`,
          bottom: `calc(${CORNER + 152}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        {atmosphere ? (
          <TouchButton
            label="VTOL"
            onPress={() => source.setChannel({ vtol: true })}
            onRelease={() => source.setChannel({ vtol: false })}
          />
        ) : (
          <TouchButton
            label="BOOST"
            onPress={() => source.setChannel({ boost: true })}
            onRelease={() => source.setChannel({ boost: false })}
          />
        )}
      </div>
      {/* RIGHT stick — pitch + roll (the attitude). */}
      <div
        id="touch-stick-right"
        style={{
          ...side,
          right: `calc(${CORNER}px + env(safe-area-inset-right, 0px))`,
          bottom: `calc(${CORNER}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <TouchJoystick label="pitch and roll stick" onChange={onRight} />
      </div>
    </div>
  );
}
