/**
 * TouchJoystick (TASK-90, PRD §4.13 / SC-6) — the generic 2-axis touch control.
 *
 * Turns pointer gestures into a normalized {x, y} vector in [-1, 1]: x is
 * RIGHT-positive, y is UP-positive (drag up = +y) to match the keyboard
 * convention (W = +thrust, F = nose up). The wiring task (TASK-91) maps the
 * vector onto flight channels — this component carries NO game semantics.
 *
 * Pointer Events + setPointerCapture on the base: once a finger lands on it,
 * drags that leave the element keep tracking (the capture stays on the base
 * div). The knob follows, clamped to the radius; magnitudes inside
 * `deadzone` (a fraction of the radius) emit {0, 0}. On release/cancel
 * {0, 0} is emitted once and the knob returns to centre.
 *
 * A11y (TASK-54): role="slider" + aria-label give the a11y suite a named
 * control; aria-valuetext exposes the live vector. Colours are theme tokens
 * only.
 */
import React from 'react';

import { useReducedMotion } from '@client/a11y/use-reduced-motion';
import { theme } from '../theme';

export interface TouchVector {
  x: number;
  y: number;
}

export interface TouchJoystickProps {
  /** Accessible name (aria-label). */
  label: string;
  /** Base diameter in px. */
  size?: number;
  /** Deadzone as a fraction of the radius (0..1). */
  deadzone?: number;
  /** Called on every press/move, and once with {0, 0} on release/cancel. */
  onChange: (v: TouchVector) => void;
  disabled?: boolean;
}

const DEFAULT_SIZE = 128;
const DEFAULT_DEADZONE = 0.15;
/** Knob diameter as a fraction of the base diameter. */
const KNOB_FRACTION = 0.42;

/**
 * Pure math: raw offset from centre → normalized vector. Clamped to the
 * radius (a drag past the edge rides the rim) and deadzoned — a magnitude
 * within deadzone × radius emits {0, 0}. y is passed already up-positive.
 * Zero components are canonicalized (+0): a horizontal drag passes -0
 * through the y flip, and Object.is(-0, 0) is false (the channels and the
 * wire must see the canonical zero — same rule as controls.ts `flip`).
 */
export function joystickVector(
  dx: number,
  dy: number,
  radius: number,
  deadzone: number,
): TouchVector {
  const canonical = (v: number): number => (v === 0 ? 0 : v);
  const mag = Math.hypot(dx, dy);
  if (mag <= radius * deadzone) return { x: 0, y: 0 };
  const scale = Math.min(1, radius / mag) / radius;
  return { x: canonical(dx * scale), y: canonical(dy * scale) };
}

/** Raw offset from centre clamped to a radius (px — the knob position). */
function clampedOffset(dx: number, dy: number, radius: number): TouchVector {
  const mag = Math.hypot(dx, dy);
  if (mag <= radius || mag === 0) return { x: dx, y: dy };
  const s = radius / mag;
  return { x: dx * s, y: dy * s };
}

export function TouchJoystick({
  label,
  size = DEFAULT_SIZE,
  deadzone = DEFAULT_DEADZONE,
  onChange,
  disabled = false,
}: TouchJoystickProps): React.ReactElement {
  const reducedMotion = useReducedMotion();
  const activeRef = React.useRef(false);
  const centerRef = React.useRef({ x: 0, y: 0 });
  const [knob, setKnob] = React.useState<TouchVector>({ x: 0, y: 0 });
  const [vector, setVector] = React.useState<TouchVector>({ x: 0, y: 0 });
  const radius = size / 2;
  const knobSize = size * KNOB_FRACTION;
  // The knob CENTRE is clamped so the disc stays inside the base; the
  // emitted vector still uses the full radius.
  const knobClamp = Math.max(0, radius - knobSize / 2);

  /** Raw SCREEN offset from centre (y DOWN-positive); the vector flips y. */
  const emit = React.useCallback(
    (sx: number, sy: number) => {
      const v = joystickVector(sx, -sy, radius, deadzone);
      setVector(v);
      setKnob(clampedOffset(sx, sy, knobClamp));
      onChange(v);
    },
    [radius, knobClamp, deadzone, onChange],
  );

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    centerRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    e.currentTarget.setPointerCapture(e.pointerId);
    activeRef.current = true;
    emit(e.clientX - centerRef.current.x, e.clientY - centerRef.current.y);
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    emit(e.clientX - centerRef.current.x, e.clientY - centerRef.current.y);
  };

  const handleEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setVector({ x: 0, y: 0 });
    setKnob({ x: 0, y: 0 });
    onChange({ x: 0, y: 0 });
  };

  return (
    <div
      role="slider"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={vector.x}
      aria-valuetext={`x ${vector.x.toFixed(2)}, y ${vector.y.toFixed(2)}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleEnd}
      onPointerCancel={handleEnd}
      style={{
        position: 'relative',
        width: size,
        height: size,
        boxSizing: 'border-box',
        borderRadius: '50%',
        background: theme.panel,
        border: `2px solid ${theme.border}`,
        touchAction: 'none',
        pointerEvents: disabled ? 'none' : 'auto',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: knobSize,
          height: knobSize,
          marginLeft: -knobSize / 2,
          marginTop: -knobSize / 2,
          borderRadius: '50%',
          background: theme.accent,
          border: `2px solid ${theme.bg}`,
          transform: `translate(${knob.x}px, ${knob.y}px)`,
          transition: reducedMotion ? 'none' : 'transform 60ms linear',
          willChange: 'transform',
        }}
      />
    </div>
  );
}
