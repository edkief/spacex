/**
 * Overview tab — TASK-53.
 *
 * Shows the ship's class stats (TASK-19 catalog), the hull /
 * shield / energy bars, and the three livery colour pickers
 * (TASK-21). The pickers are the only network-touching control in
 * the panel — the parent debounces them by 500 ms.
 */
import type * as React from "react";

import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";
import { ENERGY_MAX } from "@shared/weapons.js";

import type { LiveryColors } from "./livery.js";
import type { ShipInfo } from "./shipApi.js";

/** Props for the overview tab. */
export interface OverviewTabProps {
  /** The player's ship row (`null` while it is still loading). */
  ship: ShipInfo | null;
  /** Current weapon energy (`null` when unknown). */
  energy: number | null;
  /** Called on every picker change — the parent debounces it. */
  onLiveryChange: (colors: LiveryColors) => void;
  /** Test-id prefix for the host panel. */
  testIdPrefix: string;
}

const LIVERY_SLOTS: ReadonlyArray<{ key: keyof LiveryColors; label: string }> = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
];

const DEFAULT_LIVERY: LiveryColors = {
  primary: "#9aa6b2",
  secondary: "#4a5568",
  accent: "#7adfff",
};

/**
 * The overview body. Renders a "loading" placeholder until the
 * ship row arrives so the panel never flashes zeroed stats.
 */
export function OverviewTab({
  ship,
  energy,
  onLiveryChange,
  testIdPrefix,
}: OverviewTabProps): React.JSX.Element {
  const classId = (ship?.classId ?? "scout") as ShipClassId;
  const klass = SHIP_CLASSES[classId];
  const livery = ship?.livery ?? DEFAULT_LIVERY;

  const hullMax = klass.hull;
  const shieldMax = klass.shieldCapacity;
  const hull = ship?.hull ?? 0;
  const shields = ship?.shields ?? 0;
  const energyValue = energy ?? 0;

  return (
    <div data-testid={`${testIdPrefix}-overview`}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 14, letterSpacing: "0.12em" }}>{klass.name}</span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>{ship?.state ?? "loading"}</span>
      </div>

      {/* Vitals bars. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Bar
          label="HULL"
          value={hull}
          max={hullMax}
          colour="#f5b94d"
          testId={`${testIdPrefix}-hull-bar`}
        />
        <Bar
          label="SHIELD"
          value={shields}
          max={shieldMax}
          colour="#7adfff"
          testId={`${testIdPrefix}-shield-bar`}
        />
        <Bar
          label="ENERGY"
          value={energyValue}
          max={ENERGY_MAX}
          colour="#b48cf8"
          testId={`${testIdPrefix}-energy-bar`}
        />
      </div>

      {/* Class stats. */}
      <div
        data-testid={`${testIdPrefix}-stats`}
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 6,
          fontSize: 10,
        }}
      >
        <Stat label="Mass" value={String(klass.mass)} />
        <Stat label="Max speed" value={String(klass.maxVelocity)} />
        <Stat label="Cargo slots" value={String(klass.cargoSlots)} />
        <Stat label="Max weight" value={String(klass.maxWeight)} />
        <Stat label="Lasers" value={String(klass.weaponMounts.laser)} />
        <Stat label="Missiles" value={String(klass.weaponMounts.missiles)} />
      </div>

      {/* Livery pickers. */}
      <div style={{ marginTop: 14 }}>
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            opacity: 0.8,
            marginBottom: 6,
          }}
        >
          Livery
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {LIVERY_SLOTS.map((slot) => (
            <label
              key={slot.key}
              data-testid={`${testIdPrefix}-livery-${slot.key}`}
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10 }}
            >
              <span style={{ opacity: 0.7 }}>{slot.label}</span>
              <input
                type="color"
                aria-label={`${slot.label} colour`}
                value={livery[slot.key]}
                onChange={(ev) => onLiveryChange({ ...livery, [slot.key]: ev.target.value })}
                style={{ width: 48, height: 24, padding: 0, border: "none", background: "none" }}
              />
            </label>
          ))}
        </div>
        <p style={{ marginTop: 6, fontSize: 9, opacity: 0.55 }}>
          Paint changes are saved 500 ms after the last edit.
        </p>
      </div>
    </div>
  );
}

interface BarProps {
  label: string;
  value: number;
  max: number;
  colour: string;
  testId: string;
}

function Bar({ label, value, max, colour, testId }: BarProps): React.JSX.Element {
  const fraction = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div data-testid={testId} data-fraction={fraction.toFixed(3)}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          opacity: 0.8,
        }}
      >
        <span>{label}</span>
        <span>
          {Math.round(value)} / {max}
        </span>
      </div>
      <div
        style={{
          height: 6,
          border: "1px solid rgba(255,255,255,0.15)",
          marginTop: 2,
        }}
      >
        <div style={{ width: `${fraction * 100}%`, height: "100%", background: colour }} />
      </div>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps): React.JSX.Element {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.1)", padding: "4px 6px" }}>
      <div style={{ opacity: 0.6, fontSize: 9, textTransform: "uppercase" }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}
