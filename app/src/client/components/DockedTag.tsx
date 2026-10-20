/**
 * DockedTag — TASK-51.
 *
 * The docked-state HUD pill. Spec: "DOCKED tag (green) when on a
 * pad (TASK-29) + the station name; the prompt line shows the
 * available dock actions (Leave ship / Open cargo / Dock
 * terminal)".
 *
 * This component renders only the **visual pill** — the prompt
 * line (Leave ship / Open cargo / Dock terminal) already lives in
 * the docked state of the `InteractionPrompt` + `ExitShipPrompt`
 * + `DockPanel` components, so we deliberately don't duplicate
 * that affordance here. When the docked state is detected, this
 * pill replaces the placeholder `DockedIndicator` so the HUD reads
 * as one cohesive instrument.
 *
 * When the local ship is **not** docked the component returns
 * `null` — the slotted visibility avoids burning a render row
 * during flight.
 */
import type * as React from "react";

/** Props for the docked tag. */
export interface DockedTagProps {
  /** Pad id the ship is on, or `null` / `undefined` when not docked. */
  padId: string | null | undefined;
  /** Display name of the station / settlement the pad anchors. */
  stationName: string | null | undefined;
  /**
   * Optional list of dock actions currently in range (Leave ship /
   * Open cargo / Dock terminal). Rendered as tiny pill rows below
   * the DOCKED tag so the player sees the available prompts.
   */
  actions?: readonly string[] | null;
  /**
   * Called when the player activates the `cargo` chip. When it is
   * omitted the chips stay static hints (the pre-TASK-53 look).
   */
  onCargo?: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  exit_ship: "Leave ship",
  enter_ship: "Enter ship",
  cargo: "Open cargo",
  dock: "Dock terminal",
};

/** Pretty label for a dock action key. Exported for tests. */
export function dockActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** The shared chip style (static hint + clickable button share it). */
const actionChipStyle: React.CSSProperties = {
  padding: "2px 6px",
  background: "rgba(12, 16, 24, 0.78)",
  color: "#e6edf3",
  border: "1px solid rgba(230, 237, 243, 0.25)",
  borderRadius: 3,
  fontSize: 10,
  letterSpacing: "0.06em",
  fontFamily: "inherit",
  cursor: "pointer",
};

/**
 * Docked-state pill. Renders only when `padId !== null &&
 * padId !== undefined`. The station name falls back to the pad id
 * when the host hasn't resolved a human-readable label yet (the
 * host can derive it from the registry lookup).
 */
export function DockedTag(props: DockedTagProps): React.JSX.Element | null {
  if (props.padId === null || props.padId === undefined) return null;
  const station = props.stationName ?? props.padId;
  const actions = props.actions ?? ["exit_ship", "cargo", "dock"];
  return (
    <div
      data-testid="drift-ship-docked-tag"
      style={{
        position: "fixed",
        top: 60,
        left: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        pointerEvents: "none",
        zIndex: 850,
      }}
    >
      <div
        data-testid="drift-ship-docked-pill"
        data-pad={props.padId}
        style={{
          padding: "4px 12px",
          background: "rgba(46, 160, 67, 0.92)",
          color: "#ffffff",
          borderRadius: 4,
          fontSize: 12,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontWeight: 700,
          textAlign: "center",
          minWidth: 140,
        }}
      >
        DOCKED
        <span
          data-testid="drift-ship-docked-station"
          style={{
            display: "block",
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "none",
            fontWeight: 400,
            opacity: 0.85,
            marginTop: 1,
          }}
        >
          {station}
        </span>
      </div>
      <div
        data-testid="drift-ship-docked-actions"
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        {actions.map((a) =>
          a === "cargo" && props.onCargo !== undefined ? (
            <button
              key={a}
              type="button"
              data-action={a}
              data-testid="drift-ship-cargo-button"
              onClick={props.onCargo}
              style={actionChipStyle}
            >
              {dockActionLabel(a)}
            </button>
          ) : (
            <span key={a} data-action={a} style={actionChipStyle}>
              {dockActionLabel(a)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
