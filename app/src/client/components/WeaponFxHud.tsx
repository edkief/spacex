/**
 * WeaponFxHud — TASK-43 FX overlay.
 *
 * Renders the live FX layer (laser flashes, missile tracers +
 * smoke trail, impact flashes + screen shake) as DOM overlays
 * on top of the canvas. The render loop reads the FX layer's
 * snapshot at requestAnimationFrame cadence so the FX are
 * smooth without flooding React with state updates.
 *
 * The screen shake is implemented as a CSS `translate` on the
 * root container (default 2 px per TASK-43 spec); the laser /
 * missile / impact elements are siblings and inherit the
 * shake transform automatically.
 *
 * The component is intentionally cheap — every overlay is a
 * positioned <div> with absolute coordinates. The HUD task
 * (TASK-50) will replace this with the tuned version once the
 * camera rig settles; for v1 the goal is "fire a laser in the
 * browser, screenshot the flash".
 */
import { useEffect, useState } from "react";
import type * as React from "react";

import type { WeaponFxLayer, MissileTracer, ImpactFx } from "../fx/weapons.js";

/** Props for the WeaponFxHud. */
export interface WeaponFxHudProps {
  /** FX layer instance owned by the App. */
  layer: WeaponFxLayer;
}

/**
 * Live FX overlay. Polls the FX layer at 30 Hz (every 33 ms)
 * so flashes look smooth without flooding React with re-renders.
 */
export function WeaponFxHud(props: WeaponFxHudProps): React.JSX.Element {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => (n + 1) % 1_000_000), 33);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  const snap = props.layer.snapshot(Date.now());
  return (
    <div
      data-testid="drift-weapon-fx"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        transform:
          snap.shakePx > 0
            ? `translate(${(Math.random() - 0.5) * 2 * snap.shakePx}px, ${(Math.random() - 0.5) * 2 * snap.shakePx}px)`
            : undefined,
      }}
    >
      {snap.lasers.map((l) => (
        <LaserFlashEl key={l.id} flash={l} />
      ))}
      {snap.tracers.map((t) => (
        <MissileTracerEl key={t.id} tracer={t} />
      ))}
      {snap.impacts.map((i) => (
        <ImpactEl key={i.id} impact={i} />
      ))}
    </div>
  );
}

/**
 * A single laser line drawn as a stretched <div> with additive
 * blending. The line angle + length is computed from the start /
 * end coordinates.
 */
function LaserFlashEl({
  flash,
}: {
  flash: { id: string; startX: number; startY: number; endX: number; endY: number; color: string };
}): React.JSX.Element {
  const dx = flash.endX - flash.startX;
  const dy = flash.endY - flash.startY;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <div
      style={{
        position: "absolute",
        left: flash.startX,
        top: flash.startY,
        width: length,
        height: 2,
        background: flash.color,
        boxShadow: `0 0 8px ${flash.color}`,
        transformOrigin: "left center",
        transform: `rotate(${angle}deg)`,
        animation: "drift-laser-flash 60ms linear forwards",
        mixBlendMode: "screen",
        opacity: 1,
      }}
    />
  );
}

/**
 * A single missile tracer drawn as a small sprite at the warhead's
 * screen position. The trail quads are absolute-positioned
 * <div>s behind the tracer with `mixBlendMode: screen` + a
 * fading animation.
 */
function MissileTracerEl({ tracer }: { tracer: MissileTracer }): React.JSX.Element {
  // Project the world position to screen coordinates. v1
  // doesn't have a real camera projection so we approximate
  // by treating the world position as the offset from the
  // ship (this matches the entity registry's snapshot shape).
  // Future tasks replace this with the real camera matrix.
  const cx = window.innerWidth / 2 + tracer.x;
  const cy = window.innerHeight / 2 - tracer.y;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: cx - 4,
          top: cy - 4,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#ffb84d",
          boxShadow: "0 0 12px #ffb84d",
          mixBlendMode: "screen",
        }}
      />
      {tracer.trail.map((p, i) => {
        const px = window.innerWidth / 2 + p.x;
        const py = window.innerHeight / 2 - p.y;
        return (
          <div
            key={`${tracer.id}-${i}`}
            style={{
              position: "absolute",
              left: px - 3,
              top: py - 3,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#ffb84d",
              opacity: 0.85 - i / Math.max(1, tracer.trail.length),
              mixBlendMode: "screen",
              animation: "drift-missile-trail 250ms linear forwards",
            }}
          />
        );
      })}
    </>
  );
}

/**
 * A single impact flash + screen shake. The flash is a small
 * CSS radial-gradient overlay anchored at the impact point;
 * the screen shake comes from the parent container.
 */
function ImpactEl({ impact }: { impact: ImpactFx }): React.JSX.Element {
  const radius = impact.kind === "destroyed" ? 32 : 16;
  const colour =
    impact.kind === "destroyed"
      ? "#ff4040"
      : impact.kind === "missile-impact"
        ? "#ffb84d"
        : "#7be5ff";
  return (
    <div
      style={{
        position: "absolute",
        left: impact.x - radius,
        top: impact.y - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: "50%",
        background: `radial-gradient(${colour} 0%, ${colour}66 30%, transparent 70%)`,
        mixBlendMode: "screen",
        animation: "drift-laser-flash 250ms linear forwards",
        opacity: 1,
      }}
    />
  );
}
