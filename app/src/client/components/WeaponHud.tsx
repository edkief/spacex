/**
 * WeaponHud — TASK-43 HUD stub.
 *
 * Bottom-right HUD widget showing:
 *   - Active weapon name (LASER / MISSILE) + the weapon's
 *     energy cost per shot.
 *   - Energy bar (0..100) — amber below 75%, red below 25%.
 *   - Lockout indicator when the connection is in the
 *     anti-spam window (5 s cooldown).
 *
 * This is the v1 stub; the full HUD (shield / hull / target
 * card / weapon selector) is TASK-50. The component pulls
 * its state from the WS layer's `weapon_state` push, polled at
 * 250 ms cadence (matches the existing WeightBar / CargoPanel
 * pattern).
 */
import { useEffect, useState } from "react";
import type * as React from "react";

import type { DriftClient } from "../net/wsClient.js";
import type { WeaponId } from "@shared/weapons.js";

/** Props for the WeaponHud. */
export interface WeaponHudProps {
  /** Live DriftClient (provides the weapon-state seam). */
  client: DriftClient;
  /** Optional override for tests (skips the client polling). */
  initial?: WeaponStateSnapshot;
  /** Test seam — poll cadence in ms (default 250). */
  pollMs?: number;
}

/** Snapshot of the weapon state for the HUD. */
export interface WeaponStateSnapshot {
  activeWeapon: WeaponId;
  energy: number;
  locked: boolean;
  lockedUntilMs: number;
}

const DEFAULT_SNAPSHOT: WeaponStateSnapshot = {
  activeWeapon: "laser",
  energy: 100,
  locked: false,
  lockedUntilMs: 0,
};

const POLL_MS_DEFAULT = 250;

/**
 * Bottom-right weapon HUD. Renders the active weapon name, the
 * energy bar, and the lockout indicator when active. Hides
 * itself when no snapshot is available so the HUD doesn't flicker
 * mid-handshake.
 */
export function WeaponHud(props: WeaponHudProps): React.JSX.Element | null {
  const [snap, setSnap] = useState<WeaponStateSnapshot | null>(
    props.initial ?? null,
  );
  useEffect(() => {
    const read = (): void => {
      const w = window as unknown as {
        __driftClient?: {
          getWeaponState?: () => WeaponStateSnapshot | null;
        };
      };
      const next = w.__driftClient?.getWeaponState?.() ?? null;
      setSnap((prev) => {
        if (prev === null && next === null) return prev;
        if (prev === null || next === null) return next;
        if (
          prev.activeWeapon !== next.activeWeapon ||
          prev.energy !== next.energy ||
          prev.locked !== next.locked ||
          prev.lockedUntilMs !== next.lockedUntilMs
        ) {
          return next;
        }
        return prev;
      });
    };
    read();
    const id = window.setInterval(read, props.pollMs ?? POLL_MS_DEFAULT);
    return () => {
      window.clearInterval(id);
    };
    void props.client;
  }, [props.client, props.pollMs]);
  if (snap === null) return null;
  const ratio = Math.max(0, Math.min(1, snap.energy / 100));
  const colour =
    snap.locked
      ? "#d04848"
      : ratio < 0.25
        ? "#d04848"
        : ratio < 0.5
          ? "#f5b94d"
          : "#9aa6b2";
  return (
    <div
      data-testid="drift-weapon-hud"
      style={{
        position: "fixed",
        right: 16,
        bottom: 64,
        width: 140,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          opacity: 0.75,
          marginBottom: 2,
        }}
      >
        Weapon
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        {snap.activeWeapon === "laser" ? "Pulse Laser" : "Guided Missile"}
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "#1b1f29",
          overflow: "hidden",
          marginBottom: 4,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${(ratio * 100).toFixed(1)}%`,
            background: colour,
            transition: "width 80ms linear",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          opacity: 0.7,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{`${Math.round(snap.energy)}/100`}</span>
        {snap.locked ? (
          <span style={{ color: "#d04848" }}>LOCKED</span>
        ) : null}
      </div>
    </div>
  );
}

/** Default snapshot — exported so the WS seam can return this
 * when no fire has happened yet. */
export const DEFAULT_WEAPON_STATE = DEFAULT_SNAPSHOT;