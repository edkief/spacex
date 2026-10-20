/**
 * Cargo transfer rows — TASK-53 (TASK-39).
 *
 * The two column frames + the per-resource row used by the cargo
 * transfer table. Split out of `CargoTransferView` to keep both
 * files inside the AGENTS.md line cap.
 */
import type * as React from "react";

import type { CargoResourceType } from "@shared/world/cargo.js";

export interface ColumnProps {
  title: string;
  fill: number;
  accent: string;
  testId: string;
  children: React.ReactNode;
}

export function Column({ title, fill, accent, testId, children }: ColumnProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      style={{
        border: "1px solid rgba(255,255,255,0.12)",
        padding: 8,
        background: "rgba(0,0,0,0.3)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: 6,
          opacity: 0.85,
        }}
      >
        {title}
      </div>
      <div
        style={{
          height: 4,
          border: "1px solid rgba(255,255,255,0.15)",
          marginBottom: 8,
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${fill * 100}%`,
            height: "100%",
            background: accent,
            transition: "width 120ms ease-out",
          }}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}

export interface ResourceRowProps {
  resourceId: CargoResourceType;
  amount: number;
  weightPerUnit: number;
  colour: string;
  empty: boolean;
  actions: React.ReactNode;
}

export function ResourceRow({
  resourceId,
  amount,
  weightPerUnit,
  colour,
  empty,
  actions,
}: ResourceRowProps): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto",
        gap: 8,
        alignItems: "center",
        padding: "4px 6px",
        background: empty ? "transparent" : "rgba(255,255,255,0.04)",
        opacity: empty ? 0.45 : 1,
        height: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            background: colour,
            border: "1px solid rgba(255,255,255,0.18)",
          }}
        />
        <span style={{ minWidth: 70 }}>{resourceId}</span>
      </div>
      <div style={{ minWidth: 60, textAlign: "right" }}>
        {amount > 0 ? `${amount} (${amount * weightPerUnit}u)` : "—"}
      </div>
      <div style={{ minWidth: 56, textAlign: "right" }}>{actions}</div>
    </div>
  );
}

export const actionButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "#e6edf3",
  padding: "2px 6px",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 10,
};

export function arrowButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.25)",
    color: enabled ? "#e6edf3" : "rgba(230,237,243,0.3)",
    cursor: enabled ? "pointer" : "not-allowed",
    width: 22,
    height: 22,
    padding: 0,
    fontFamily: "monospace",
    fontSize: 12,
  };
}
