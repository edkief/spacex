/**
 * Claims screen — TASK-56 first-launch entry point.
 *
 * Rendered whenever the client boots without a usable session. The
 * panel is the only thing on screen until a claim lands: the game
 * tree is not mounted behind it, so a first launch costs nothing
 * until the player has a callsign.
 *
 * Layout (per the acceptance criteria):
 *
 *   1. The game title `DRIFT`.
 *   2. The 3-step intro carousel (auto-advancing, skippable) —
 *      see `./IntroCarousel.tsx`.
 *   3. A callsign input with live validation: the format check
 *      runs locally, the availability probe on a 500 ms debounce —
 *      see `./useClaimsAvailability.ts`.
 *   4. A `Claim` button, disabled until both checks pass.
 *
 * On a successful claim the host (`useFirstLaunch`) stores the
 * token, starts the WS handshake, and unmounts this screen — there
 * is no intermediate screen.
 *
 * The expired-session notice renders when the caller supplies a
 * callsign: v1 has no account recovery (documented in TASK-69), so
 * the copy tells the player to claim a *new* callsign rather than
 * pretending the old one can be reclaimed.
 *
 * @see ./useClaimsAvailability.ts for the debounced probe.
 * @see ./IntroCarousel.tsx for the onboarding carousel.
 * @see ../boot/useFirstLaunch.ts for the boot state machine.
 */
import { useCallback, useMemo, useState } from "react";
import type * as React from "react";

import { CALLSIGN_MAX, CALLSIGN_MIN, CallsignSchema } from "@shared/claims.js";
import { IntroCarousel } from "./IntroCarousel.js";
import { useClaimsAvailability, type ClaimsAvailability } from "./useClaimsAvailability.js";

/** Props for `<ClaimsScreen>`. */
export interface ClaimsScreenProps {
  /** Optional expired-session banner copy (TASK-56 AC #2). */
  expiredCallsign?: string | null;
  /** Called when the user clicks `Claim` — the host drives the POST. */
  onClaim: (input: { callsign: string }) => Promise<void>;
  /** True while the host's claim POST is in flight. */
  claiming: boolean;
  /** Last claim error message (cleared on input change). */
  claimError?: string | null;
  /** Injectable fetch (tests drive the probe without the network). */
  fetcher?: typeof fetch;
}

/** The chip's rendered state — also the `data-state` attribute. */
type ChipState = "idle" | "checking" | "available" | "taken" | "invalid" | "error";

/** Collapse the probe result into a chip state + label + colour. */
function describeChip(
  callsign: string,
  formatOk: boolean,
  availability: ClaimsAvailability,
): { state: ChipState; text: string; color: string } {
  const idle = {
    state: "idle" as const,
    text: `${CALLSIGN_MIN}–${CALLSIGN_MAX} characters`,
    color: "#9aa3ad",
  };
  if (callsign.length === 0) return idle;
  if (!formatOk) return { state: "invalid", text: "invalid format", color: "#f59f9f" };
  if (availability.kind === "checking") {
    return { state: "checking", text: "checking…", color: "#9aa3ad" };
  }
  if (availability.kind === "error") {
    return { state: "error", text: "availability check failed", color: "#f59f9f" };
  }
  if (availability.kind !== "done") return idle;
  if (availability.result.available) {
    return { state: "available", text: "available", color: "#7be0a3" };
  }
  if (availability.result.reason === "taken") {
    return { state: "taken", text: "taken", color: "#f59f9f" };
  }
  return { state: "invalid", text: "invalid format", color: "#f59f9f" };
}

/**
 * The centred first-launch panel. The `data-testid` attributes are
 * the e2e selectors used by the headline Playwright test.
 */
export function ClaimsScreen({
  expiredCallsign,
  onClaim,
  claiming,
  claimError,
  fetcher,
}: ClaimsScreenProps): React.JSX.Element {
  const [callsign, setCallsign] = useState("");
  const trimmed = callsign.trim();
  const format = useMemo(() => CallsignSchema.safeParse(trimmed), [trimmed]);
  const availability = useClaimsAvailability(callsign, fetcher);
  const chip = describeChip(callsign, format.success, availability);

  // Claim is gated on: valid format, a positive probe verdict, no
  // probe in flight (so the button doesn't flicker mid-typing), and
  // no host POST already running.
  const canClaim =
    format.success &&
    availability.kind === "done" &&
    availability.result.reason === "available" &&
    availability.result.available &&
    !claiming;

  const submit = useCallback(
    (ev: React.FormEvent<HTMLFormElement>) => {
      ev.preventDefault();
      if (!canClaim || !format.success) return;
      void onClaim({ callsign: format.data });
    },
    [canClaim, onClaim, format],
  );

  return (
    <div
      data-testid="drift-claims-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "radial-gradient(circle at 50% 38%, #131b29 0%, #05060a 78%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        zIndex: 1500,
      }}
    >
      <form
        data-testid="drift-claims-panel"
        onSubmit={submit}
        style={{
          width: 420,
          padding: "32px 32px 28px",
          background: "rgba(20, 24, 32, 0.96)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 10,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <h1
          data-testid="drift-claims-title"
          style={{
            margin: 0,
            fontSize: 36,
            letterSpacing: "0.42em",
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          DRIFT
        </h1>

        {expiredCallsign ? (
          <div
            data-testid="drift-claims-expired-notice"
            role="status"
            style={{
              padding: "8px 12px",
              background: "rgba(248, 81, 73, 0.18)",
              border: "1px solid rgba(248, 81, 73, 0.45)",
              borderRadius: 6,
              color: "#fce0dd",
              fontSize: 12,
              letterSpacing: "0.04em",
              lineHeight: 1.4,
            }}
          >
            <strong style={{ display: "block", marginBottom: 4 }}>Your session expired</strong>
            Your previous callsign{" "}
            <span
              style={{
                fontFamily: "monospace",
                letterSpacing: "0.04em",
                color: "#9aa3ad",
                textDecoration: "line-through",
              }}
            >
              {expiredCallsign}
            </span>{" "}
            is taken — pick a new callsign below to continue.
          </div>
        ) : null}

        <IntroCarousel />

        <label
          htmlFor="drift-claims-callsign-input"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.16em",
            color: "#9aa3ad",
          }}
        >
          Callsign
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            id="drift-claims-callsign-input"
            data-testid="drift-claims-callsign-input"
            value={callsign}
            onChange={(e) => setCallsign(e.target.value)}
            maxLength={CALLSIGN_MAX + 4}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="Pilot-1"
            aria-label="Callsign"
            aria-describedby="drift-claims-chip"
            style={{
              padding: "10px 12px",
              fontSize: 18,
              fontFamily: "monospace",
              letterSpacing: "0.08em",
              background: "#0c1118",
              color: "#e6edf3",
              border: `1px solid ${canClaim ? "rgba(123, 224, 163, 0.7)" : "rgba(255,255,255,0.16)"}`,
              borderRadius: 6,
              outline: "none",
            }}
          />
          <div
            id="drift-claims-chip"
            data-testid="drift-claims-chip"
            data-state={chip.state}
            style={{ fontSize: 11, color: chip.color, letterSpacing: "0.04em" }}
          >
            {chip.text}
          </div>
        </div>

        <button
          type="submit"
          data-testid="drift-claims-claim-button"
          disabled={!canClaim}
          style={{
            padding: "10px 16px",
            fontSize: 14,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "inherit",
            background: canClaim ? "rgba(46, 160, 67, 0.92)" : "rgba(46, 160, 67, 0.32)",
            color: "#ffffff",
            border: "none",
            borderRadius: 6,
            cursor: canClaim ? "pointer" : "not-allowed",
          }}
        >
          {claiming ? "Claiming…" : "Claim"}
        </button>

        {claimError ? (
          <div
            data-testid="drift-claims-error"
            role="alert"
            style={{
              padding: "8px 12px",
              background: "rgba(248, 81, 73, 0.18)",
              border: "1px solid rgba(248, 81, 73, 0.45)",
              borderRadius: 6,
              color: "#fce0dd",
              fontSize: 12,
              letterSpacing: "0.04em",
            }}
          >
            {claimError}
          </div>
        ) : null}
      </form>
    </div>
  );
}
