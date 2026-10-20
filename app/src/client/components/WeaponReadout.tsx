/**
 * WeaponReadout — TASK-50 step 2 (weapon / energy).
 *
 * Bottom-center combat readout, above the prompt line:
 *
 *   - **Active weapon** — `LASER` / `MISSILE`.
 *   - **Weapon selector** — the `1` / `2` slots with their loadout
 *     counts (`2x` for dual lasers, `4` for the missile bay).
 *   - **Energy bar** — 100 max; amber below 25 %, red below 10 %
 *     with a `LOW ENERGY` badge.
 *   - **Missile count** — rounds on the selected missile weapon.
 *
 * State is snapshot-driven at the 10 Hz cadence (`HUD_STATE_POLL_MS`),
 * so the readout costs one store read per tick rather than a
 * per-frame re-render.
 */

import { useEffect, useState } from "react";
import type * as React from "react";

import { ENERGY_MAX, type WeaponId } from "@shared/weapons.js";
import type { ShipClassId } from "@shared/ships.js";
import { hudSlots, HUD_STATE_POLL_MS } from "../combat/hud/layout.js";
import {
  LOW_ENERGY_LABEL,
  energyBarState,
  missileCountFor,
  weaponSlots,
} from "../combat/hud/energy.js";
import type { WeaponStateSnapshot } from "./WeaponHud.js";

/** Snapshot the readout renders from. */
export interface WeaponReadoutProps {
  /** Live weapon state (or `null` mid-handshake → renders hidden). */
  state: WeaponStateSnapshot | null;
  /** Own ship class id (drives the selector counts). */
  classId?: ShipClassId | null;
  /** Rounds left on the missile weapon (null = unknown). */
  missilesLeft?: number | null;
  /** Called when the player clicks a selector slot. */
  onSelect?: (weapon: WeaponId) => void;
  /** Poll cadence in ms for the store hook (default 100). */
  pollMs?: number;
}

/** The four regions the readout renders. */
export function WeaponReadout(props: WeaponReadoutProps): React.JSX.Element | null {
  if (props.state === null) return null;
  const state = props.state;
  const slots = weaponSlots(props.classId ?? null);
  const bar = energyBarState(state.energy);
  const missiles = missileCountFor(state.activeWeapon, props.missilesLeft ?? null);
  const rect = hudSlots().weaponReadout;
  const active = state.activeWeapon;
  return (
    <div
      data-testid="drift-weapon-readout"
      data-slot="weaponReadout"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        zIndex: 940,
        pointerEvents: "none",
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {slots.map((slot) => (
          <button
            key={slot.key}
            type="button"
            data-testid="drift-weapon-slot"
            data-slot-key={slot.key}
            data-active={slot.weapon === active ? "true" : "false"}
            aria-label={`weapon-slot-${slot.weapon}`}
            onClick={() => props.onSelect?.(slot.weapon)}
            style={{
              background: slot.weapon === active ? "rgba(245,185,77,0.22)" : "rgba(12,16,24,0.6)",
              border:
                slot.weapon === active ? "1px solid #f5b94d" : "1px solid rgba(255,255,255,0.2)",
              color: slot.available ? "#e6edf3" : "#5c6672",
              fontSize: 11,
              letterSpacing: "0.12em",
              padding: "4px 10px",
              borderRadius: 4,
              cursor: slot.available ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}
          >
            <span style={{ opacity: 0.7 }}>{slot.key}</span> {slot.label}
            <span style={{ marginLeft: 6, color: bar.color }}>{slot.countLabel}</span>
          </button>
        ))}
      </div>
      <div
        style={{
          height: 8,
          marginTop: 6,
          background: "#1b1f29",
          borderRadius: 4,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          data-testid="drift-energy-bar"
          data-level={bar.level}
          style={{
            height: "100%",
            width: `${(bar.ratio * 100).toFixed(1)}%`,
            background: bar.color,
            transition: "width 100ms linear",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          letterSpacing: "0.1em",
          marginTop: 3,
        }}
      >
        <span data-testid="drift-energy-value">{`${Math.round(bar.energy)}/${ENERGY_MAX}`}</span>
        {missiles !== null ? (
          <span data-testid="drift-missile-count">{`MISSILES ${missiles}`}</span>
        ) : null}
        {bar.lowEnergy ? (
          <span data-testid="drift-low-energy" style={{ color: bar.color }}>
            {LOW_ENERGY_LABEL}
          </span>
        ) : null}
        {state.locked ? (
          <span data-testid="drift-weapon-locked" style={{ color: "#d04848" }}>
            LOCKED
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Poll `read()` at the HUD state cadence (10 Hz by default) and
 * return the latest snapshot. Kept out of the component so the
 * component stays a pure renderer (and testable with a plain prop).
 */
export function useWeaponStatePoll(
  read: () => WeaponStateSnapshot | null,
  pollMs: number = HUD_STATE_POLL_MS,
): WeaponStateSnapshot | null {
  const [state, setState] = useState<WeaponStateSnapshot | null>(null);
  useEffect(() => {
    const tick = (): void => {
      const next = read();
      setState((prev) => {
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
    tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      window.clearInterval(id);
    };
  }, [read, pollMs]);
  return state;
}
