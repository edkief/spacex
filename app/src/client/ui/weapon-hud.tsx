import React from 'react';
import { ENERGY_MAX, loadoutFor, WEAPON_BY_ID } from '@shared/weapons';

/**
 * Weapon HUD stub (TASK-43 step 3 — the FULL ship HUD is TASK-50/51):
 * the active weapon name (1/2 keys switch) + the energy bar (the SELF
 * entity_update's `energy`, 10 Hz) + the denial prompts ('LOW ENERGY' /
 * 'WEAPON LOCKED' — the server's {code} error frames).
 */
export interface WeaponHudProps {
  /** The player's ship class (null before the first self ship entity). */
  classId: string | null;
  /** The ship's energy (absolute 0..100; null before the first snapshot). */
  energy: number | null;
  /** The active weapon (client state, the 1/2 keys). */
  weapon: 'laser' | 'missile';
  onWeapon: (weapon: 'laser' | 'missile') => void;
  /** Server denial prompts (transient, self-clearing in main.tsx). */
  lowEnergy: boolean;
  locked: boolean;
}

export function WeaponHud({ classId, energy, weapon, onWeapon, lowEnergy, locked }: WeaponHudProps) {
  const loadout = React.useMemo(() => (classId ? loadoutFor(classId) : []), [classId]);
  if (!classId) return null;
  const e = energy ?? ENERGY_MAX;
  const cost = WEAPON_BY_ID[weapon].energy ?? 0;
  const pct = Math.max(0, Math.min(100, (e / ENERGY_MAX) * 100));
  const active = loadout.some((w) => w.id === weapon);
  return (
    <div
      id="weapon-hud"
      role="status"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 90,
        pointerEvents: 'none',
        fontFamily: 'monospace',
        fontSize: 12,
        color: '#cdd6e4',
        background: 'rgba(10, 14, 22, 0.55)',
        border: '1px solid rgba(120, 140, 170, 0.35)',
        padding: '8px 10px',
        width: 190,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        {loadout.map((w, i) => (
          <button
            key={w.id}
            type="button"
            onClick={() => onWeapon(w.id)}
            style={{
              pointerEvents: 'auto',
              fontFamily: 'inherit',
              fontSize: 11,
              cursor: 'pointer',
              background: w.id === weapon && active ? 'rgba(224, 92, 66, 0.25)' : 'transparent',
              color: w.id === weapon && active ? '#ff9a76' : '#8fa0b8',
              border: '1px solid rgba(120, 140, 170, 0.35)',
              padding: '2px 6px',
            }}
          >
            {i + 1} {w.id.toUpperCase()}
          </button>
        ))}
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{active ? weapon.toUpperCase() : '—'}</span>
          <span>
            {Math.floor(e)}/{ENERGY_MAX}
          </span>
        </div>
        <div
          style={{
            height: 4,
            background: 'rgba(120, 140, 170, 0.2)',
            marginTop: 2,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background: e < cost ? '#e05c42' : '#5cb8e0',
            }}
          />
        </div>
      </div>
      {lowEnergy && <div style={{ color: '#ff9a76', marginTop: 4 }}>LOW ENERGY</div>}
      {locked && <div style={{ color: '#ff9a76', marginTop: 4 }}>WEAPON LOCKED</div>}
    </div>
  );
}
