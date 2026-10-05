import React from 'react';
import { CALLSIGN_PATTERN } from '@shared/callsign';
import type { ClaimedSession } from '@client/net/session';
import { saveSession } from '@client/net/session-boot';

/**
 * TASK-56: the claims screen — the ONLY entry to a session.
 *
 * A centered panel (the starfield shows through behind it): the game title,
 * the 3-step intro (auto-advancing, 4 s each, skippable), a callsign input
 * with live validation (format check + the server availability probe,
 * debounced 500 ms — 'available' green / 'taken' red) and the Claim button
 * (disabled until valid AND available). On success the session is stored
 * and the app boots straight into the home-system dock.
 *
 * Expired mode (a stored token that /api/session rejected): the old
 * callsign is shown DISABLED — v1 has no recovery, so the message says so
 * plainly ('Claim a new callsign.').
 */

/** The 3-step intro (4 s each, auto-advancing, skippable). */
const INTRO_STEPS = [
  'This is a living galaxy. Every system is real.',
  'Fly. Land. Go on foot. No loading screens.',
  'Mine. Haul. Sell. Survive.',
] as const;

/** One intro step's lifetime before it auto-advances. */
export const INTRO_STEP_MS = 4_000;
/** The availability probe's debounce. */
export const AVAILABILITY_DEBOUNCE_MS = 500;

export type ClaimAvailability = 'idle' | 'invalid' | 'checking' | 'available' | 'taken';

interface ClaimsScreenProps {
  /** The expired callsign (input prefilled + disabled), or null. */
  expiredCallsign: string | null;
  /** A successful claim (the session is already stored by then). */
  onClaimed: (s: ClaimedSession) => void;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const panelStyle: React.CSSProperties = {
  width: 400,
  border: '1px solid rgba(125, 211, 252, 0.4)',
  borderRadius: 8,
  background: 'rgba(8, 12, 18, 0.92)',
  padding: 28,
  fontFamily: MONO,
  color: '#e2e8f0',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const GREEN = '#4ade80';
const RED = '#f87171';
const AMBER = '#fbbf24';

/** The status line for a validation state (null = nothing to say). */
export function claimStatusFor(
  availability: ClaimAvailability,
  expired: boolean,
): { text: string; color: string } | null {
  if (expired) return { text: 'session expired — claim a new callsign', color: AMBER };
  switch (availability) {
    case 'invalid':
      return { text: '3–16 chars: letters, numbers, dash', color: RED };
    case 'checking':
      return { text: 'checking…', color: '#94a3b8' };
    case 'available':
      return { text: 'available', color: GREEN };
    case 'taken':
      return { text: 'taken', color: RED };
    case 'idle':
      return null;
  }
}

export function ClaimsScreen({
  expiredCallsign,
  onClaimed,
}: ClaimsScreenProps): React.ReactElement {
  const expired = expiredCallsign !== null;
  const [callsign, setCallsign] = React.useState(expiredCallsign ?? '');
  const [availability, setAvailability] = React.useState<ClaimAvailability>('idle');
  const [busy, setBusy] = React.useState(false);
  const [fail, setFail] = React.useState<string | null>(null);
  /** The intro step (0-based); -1 = skipped. */
  const [introStep, setIntroStep] = React.useState(0);
  /** In-flight availability request id (stale responses are dropped). */
  const requestRef = React.useRef(0);

  // The intro: auto-advance every 4 s, stop at the last step.
  React.useEffect(() => {
    if (introStep < 0 || introStep >= INTRO_STEPS.length - 1) return undefined;
    const t = setTimeout(() => setIntroStep((s) => (s < 0 ? s : s + 1)), INTRO_STEP_MS);
    return () => clearTimeout(t);
  }, [introStep]);

  // Live validation: format immediately, then the debounced probe.
  React.useEffect(() => {
    if (expired) return undefined;
    if (!CALLSIGN_PATTERN.test(callsign)) {
      setAvailability('invalid');
      return undefined;
    }
    setAvailability('checking');
    const id = ++requestRef.current;
    const t = setTimeout(() => {
      fetch(`/api/callsigns/availability?callsign=${encodeURIComponent(callsign)}`)
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { available: boolean };
          if (requestRef.current === id) {
            setAvailability(body.available ? 'available' : 'taken');
          }
        })
        .catch(() => {
          if (requestRef.current === id) setAvailability('idle');
        });
    }, AVAILABILITY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [callsign, expired]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setFail(null);
    try {
      const res = await fetch('/api/callsigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callsign }),
      });
      const body = (await res.json()) as Partial<ClaimedSession> & { code?: string };
      if (!res.ok || !body.token || !body.playerId || !body.homeSystemId) {
        if (res.status === 409) {
          setAvailability('taken');
          setFail('That callsign is already taken.');
        } else {
          setFail(`claim failed: ${body.code ?? res.status}`);
        }
        return;
      }
      const session = body as ClaimedSession;
      saveSession(session);
      onClaimed(session);
    } catch {
      setFail('claim failed: server unreachable');
    } finally {
      setBusy(false);
    }
  };

  const claimEnabled = !expired && !busy && availability === 'available';
  const status = claimStatusFor(availability, expired);

  return (
    <div
      id="claims-screen"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 120,
      }}
    >
      <form onSubmit={submit} style={panelStyle} aria-label="Claim a callsign">
        <h1
          id="claims-title"
          style={{
            margin: 0,
            textAlign: 'center',
            fontSize: 28,
            letterSpacing: 10,
            color: '#7dd3fc',
          }}
        >
          DRIFT
        </h1>

        {/* The 3-step intro: auto-advancing (4 s), skippable. */}
        {introStep >= 0 && (
          <div
            id="claims-intro"
            role="note"
            style={{
              border: '1px solid rgba(125, 211, 252, 0.2)',
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 13,
              color: '#cbd5e1',
              textAlign: 'center',
            }}
          >
            <p id="claims-intro-text" style={{ margin: 0 }}>
              {INTRO_STEPS[introStep]}
            </p>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'center' }}>
                {INTRO_STEPS.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: i === introStep ? '#7dd3fc' : 'rgba(125, 211, 252, 0.25)',
                    }}
                  />
                ))}
              </span>
              <button
                id="claims-skip"
                type="button"
                onClick={() => setIntroStep(-1)}
                style={{
                  background: 'none',
                  border: '1px solid rgba(125, 211, 252, 0.4)',
                  borderRadius: 4,
                  color: '#94a3b8',
                  fontSize: 11,
                  padding: '2px 8px',
                  cursor: 'pointer',
                }}
              >
                SKIP
              </button>
            </div>
          </div>
        )}

        {expired && (
          <p
            id="claims-expired"
            role="alert"
            style={{ margin: 0, fontSize: 13, color: AMBER, textAlign: 'center' }}
          >
            Your session expired. Claim a new callsign.
          </p>
        )}

        <label
          htmlFor="callsign-input"
          style={{ fontSize: 12, letterSpacing: 2, color: '#94a3b8' }}
        >
          CALLSIGN
        </label>
        <input
          id="callsign-input"
          value={callsign}
          onChange={(e) => setCallsign(e.target.value)}
          placeholder="3–16 alphanumerics"
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          disabled={expired}
          style={{
            background: 'rgba(15, 23, 42, 0.8)',
            border: `1px solid ${availability === 'taken' || availability === 'invalid' ? RED : 'rgba(125, 211, 252, 0.4)'}`,
            borderRadius: 4,
            color: '#e2e8f0',
            fontFamily: MONO,
            fontSize: 15,
            padding: '8px 10px',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />
        <p
          id="claims-status"
          role="status"
          aria-live="polite"
          style={{
            margin: '-8px 0 0',
            fontSize: 12,
            color: status?.color ?? 'transparent',
            minHeight: 16,
          }}
        >
          {status?.text ?? ''}
        </p>
        <button
          id="claim-button"
          type="submit"
          disabled={!claimEnabled}
          style={{
            background: claimEnabled ? 'rgba(125, 211, 252, 0.15)' : 'rgba(30, 41, 59, 0.5)',
            border: `1px solid ${claimEnabled ? '#7dd3fc' : 'rgba(125, 211, 252, 0.2)'}`,
            borderRadius: 4,
            color: claimEnabled ? '#e0f2fe' : '#64748b',
            fontFamily: MONO,
            fontSize: 14,
            letterSpacing: 3,
            padding: '10px 0',
            cursor: claimEnabled ? 'pointer' : 'default',
          }}
        >
          {busy ? 'CLAIMING…' : 'CLAIM'}
        </button>
        {fail && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: RED }}>
            {fail}
          </p>
        )}
      </form>
    </div>
  );
}
