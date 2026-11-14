import { useState, type FormEvent } from 'react';
import { ApiError } from '../net/session.ts';

const MESSAGES: Readonly<Record<string, string>> = {
  'callsign-taken': 'That callsign is taken. Try another.',
  'invalid-request': 'Use 3-16 letters, digits or dashes (no dash at either end).',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
};

export interface CallsignFormProps {
  /** Claims the callsign; rejects with ApiError when the server refuses. */
  onClaim: (callsign: string) => Promise<void>;
}

/** First-run screen: pick a unique callsign. Errors are shown inline with a next action. */
export function CallsignForm({ onClaim }: CallsignFormProps) {
  const [callsign, setCallsign] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    onClaim(callsign.trim())
      .catch((reason: unknown) => {
        const code = reason instanceof ApiError ? reason.code : 'internal';
        setError(MESSAGES[code] ?? 'Could not reach the server. Try again.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className="panel callsign" onSubmit={submit} data-testid="callsign-form">
      <h1>Drift</h1>
      <label htmlFor="callsign">Choose your callsign</label>
      <input
        id="callsign"
        name="callsign"
        value={callsign}
        onChange={(event) => setCallsign(event.target.value)}
        minLength={3}
        maxLength={16}
        pattern="[A-Za-z0-9\-]+"
        autoComplete="off"
        autoFocus
        required
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Claiming…' : 'Launch'}
      </button>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
