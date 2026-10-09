/**
 * TouchButton (TASK-90, PRD §4.13 / SC-6) — the generic touch button.
 *
 * pointerdown → onPress, pointerup/pointercancel → onRelease, so a long
 * hold stays "pressed" for its whole duration (e.g. FIRE). The pointer
 * handlers live on a hit wrapper that is at least `minTouch` (44 px, the
 * WCAG minimum tap target) wide even when the visual disc is smaller.
 *
 * A11y (TASK-54): aria-label (the visible text doubles as the name) and
 * aria-pressed when `pressed` is controlled; text/icon colours are theme
 * tokens only, so the contrast suite covers them.
 */
import React from 'react';

import { theme } from '../theme';

export interface TouchButtonProps {
  /** Visible text (also the accessible name). */
  label: string;
  icon?: React.ReactNode;
  /** Visual diameter in px. */
  size?: number;
  /** Minimum hit target in px (enforced even when size is smaller). */
  minTouch?: number;
  onPress: () => void;
  onRelease: () => void;
  disabled?: boolean;
  /** Controlled held state (e.g. FIRE); drives aria-pressed + the accent border. */
  pressed?: boolean;
}

const DEFAULT_SIZE = 64;
const DEFAULT_MIN_TOUCH = 44;

export function TouchButton({
  label,
  icon,
  size = DEFAULT_SIZE,
  minTouch = DEFAULT_MIN_TOUCH,
  onPress,
  onRelease,
  disabled = false,
  pressed,
}: TouchButtonProps): React.ReactElement {
  const pressedRef = React.useRef(false);
  const hitSize = Math.max(size, minTouch);

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressedRef.current = true;
    onPress();
  };

  const handleEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only release a press we started (a stray pointerup must not fire).
    if (disabled || !pressedRef.current) return;
    pressedRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onRelease();
  };

  return (
    <div
      role="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onPointerDown={handleDown}
      onPointerUp={handleEnd}
      onPointerCancel={handleEnd}
      style={{
        width: hitSize,
        height: hitSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
        pointerEvents: disabled ? 'none' : 'auto',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          boxSizing: 'border-box',
          borderRadius: '50%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: theme.surface,
          border: `2px solid ${pressed ? theme.accent : theme.border}`,
          color: disabled ? theme.textMuted : theme.text,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: Math.max(9, Math.round(size * 0.16)),
          lineHeight: 1.1,
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {icon}
        <span>{label}</span>
      </div>
    </div>
  );
}
