import { useEffect, useState } from 'react';
import { getDriftCanvas } from './canvas.ts';
import { startGame, type GameView } from './game.ts';
import {
  claimCallsign,
  clearToken,
  fetchClientConfig,
  loadToken,
  resumeSession,
  storeToken,
  type ClientConfig,
  type SessionInfo,
} from './net/session.ts';
import { CallsignForm } from './ui/CallsignForm.tsx';
import { Hud } from './ui/Hud.tsx';

type Phase =
  | { name: 'loading' }
  | { name: 'unreachable' }
  | { name: 'callsign'; config: ClientConfig }
  | { name: 'playing'; config: ClientConfig; session: SessionInfo };

/** Loads the server config and resumes a stored session if it is still valid. */
async function boot(): Promise<Phase> {
  const config = await fetchClientConfig();
  const token = loadToken();
  const session = token ? await resumeSession(token) : undefined;
  if (token && !session) clearToken();
  return session ? { name: 'playing', config, session } : { name: 'callsign', config };
}

/**
 * DOM shell for menus and HUD: callsign entry on first run, then the HUD over the game. The
 * three.js canvas is deliberately not rendered by React; the game is started against it.
 */
export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [view, setView] = useState<GameView | undefined>();

  useEffect(() => {
    let cancelled = false;
    boot()
      .then((next) => !cancelled && setPhase(next))
      .catch(() => !cancelled && setPhase({ name: 'unreachable' }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase.name !== 'playing') return undefined;
    const game = startGame({
      canvas: getDriftCanvas(),
      session: phase.session,
      config: phase.config,
    });
    const unsubscribe = game.subscribe(setView);
    return () => {
      unsubscribe();
      game.stop();
    };
  }, [phase]);

  return (
    <main data-testid="app-shell" data-phase={phase.name}>
      {phase.name === 'loading' ? <p className="panel">Drift — loading…</p> : null}
      {phase.name === 'unreachable' ? (
        <div className="panel" role="alert">
          <h1>Drift</h1>
          <p>The server is unreachable.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : null}
      {phase.name === 'callsign' ? (
        <CallsignForm
          onClaim={async (callsign) => {
            const session = await claimCallsign(callsign);
            storeToken(session.token);
            setPhase({ name: 'playing', config: phase.config, session });
          }}
        />
      ) : null}
      {phase.name === 'playing' && view ? <Hud view={view} /> : null}
    </main>
  );
}
