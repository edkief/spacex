/**
 * TASK-50: the WEAPON READOUT (bottom-center, above the prompt line) — the
 * active weapon name, the 1/2 weapon selector (mount counts, e.g. '×2' for
 * the interceptor's dual lasers), the energy bar (100 max; amber < 25,
 * red < 10 + 'LOW ENERGY'), and the missile count for the missile weapon.
 * 10 Hz state cadence (the self ship's entity_update energy).
 *
 * Replaces the TASK-43 stub (same #weapon-hud id — the weapons e2e keeps
 * working: 'LASER' + '100/100').
 */
import React from 'react';
import { ENERGY_MAX, loadoutFor, type WeaponId } from '@shared/weapons';
import { SHIP_CLASSES, type ShipClassId } from '@shared/ships';
import { styleFromRect, weaponReadoutRect, type Viewport } from './layout';

export interface WeaponReadoutProps {
  viewport: Viewport;
  /** The player's ship class (null on foot / before the first snapshot). */
  classId: string | null;
  /** The ship's energy (absolute 0..100; null before the first snapshot). */
  energy: number | null;
  /** The active weapon (client state, the 1/2 keys). */
  weapon: WeaponId;
  onWeapon: (weapon: WeaponId) => void;
  /** Server denial prompts (transient, self-clearing in main.tsx). */
  lowEnergy: boolean;
  locked: boolean;
}

/** Energy bar color: red < 10, amber < 25, blue otherwise. */
export function energyBarColor(e: number): string {
  if (e < 10) return '#e05c42';
  if (e < 25) return '#ffd23f';
  return '#5cb8e0';
}

export function WeaponReadout({
  viewport,
  classId,
  energy,
  weapon,
  onWeapon,
  lowEnergy,
  locked,
}: WeaponReadoutProps) {
  const cls = classId ? SHIP_CLASSES[classId as ShipClassId] : undefined;
  const loadout = classId ? loadoutFor(classId) : [];
  if (!cls) return null;
  const e = energy ?? ENERGY_MAX;
  const active = loadout.some((w) => w.id === weapon);
  const mounts = weapon === 'laser' ? cls.weaponMounts.laser : cls.weaponMounts.missiles;

  return (
    <div
      id="weapon-hud"
      role="status"
      data-testid="weapon-readout"
      style={styleFromRect(weaponReadoutRect(viewport), {
        zIndex: 90,
        pointerEvents: 'none',
        boxSizing: 'border-box',
        overflow: 'hidden',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: '#cdd6e4',
        background: 'rgba(10, 14, 22, 0.62)',
        border: '1px solid rgba(120, 140, 170, 0.45)',
        padding: '6px 10px',
      })}
    >
      {/* Selector: the 1/2 keys, loadout counts (dual lasers show '×2'). */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        {loadout.map((w, i) => {
          const n = w.id === 'laser' ? cls.weaponMounts.laser : cls.weaponMounts.missiles;
          const isSel = w.id === weapon && active;
          return (
            <button
              key={w.id}
              type="button"
              data-testid={`weapon-select-${w.id}`}
              onClick={() => onWeapon(w.id)}
              style={{
                pointerEvents: 'auto',
                fontFamily: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
                padding: '1px 6px',
                background: isSel ? 'rgba(224, 92, 66, 0.25)' : 'transparent',
                color: isSel ? '#ff9a76' : '#8fa0b8',
                border: '1px solid rgba(120, 140, 170, 0.35)',
              }}
            >
              {i + 1} {w.id.toUpperCase()}
              {n > 1 ? ` ×${n}` : ''}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>
          {active ? weapon.toUpperCase() : '—'}
          {active && weapon === 'missile' && mounts > 0 && (
            <span data-testid="missile-count" style={{ color: '#8fa0b8' }}>
              {' '}
              ×{mounts}
            </span>
          )}
        </span>
        <span data-testid="energy-value">
          {Math.floor(e)}/{ENERGY_MAX}
        </span>
      </div>
      <div
        style={{
          height: 5,
          background: 'rgba(120, 140, 170, 0.2)',
          marginTop: 3,
        }}
      >
        <div
          data-testid="energy-bar"
          style={{
            height: '100%',
            width: `${Math.max(0, Math.min(100, (e / ENERGY_MAX) * 100))}%`,
            background: energyBarColor(e),
          }}
        />
      </div>
      {(lowEnergy || e < 10) && (
        <div data-testid="low-energy" style={{ color: '#ff9a76', marginTop: 3 }}>
          LOW ENERGY
        </div>
      )}
      {locked && (
        <div data-testid="weapon-locked" style={{ color: '#ff9a76', marginTop: 3 }}>
          WEAPON LOCKED
        </div>
      )}
    </div>
  );
}
