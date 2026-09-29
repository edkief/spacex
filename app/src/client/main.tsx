import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthPayload } from '@shared/health';

/** Fetches the REST health endpoint through the Vite same-origin proxy. */
async function fetchHealth(): Promise<HealthPayload | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    return (await res.json()) as HealthPayload;
  } catch {
    return null;
  }
}

/**
 * Minimal React shell. React owns the DOM UI (HUD/menu placeholder) only;
 * the three.js renderer will take over the canvas, which is mounted outside
 * React so it survives re-renders.
 */
function App() {
  const [health, setHealth] = React.useState<HealthPayload | null>(null);
  React.useEffect(() => {
    void fetchHealth().then(setHealth);
  }, []);

  return (
    <div style={styles.shell}>
      <canvas id="game-canvas" style={styles.canvas} />
      <div style={styles.hud}>
        <h1 style={styles.title}>DRIFT</h1>
        <p style={styles.status}>
          {health?.ok ? `server ok — seed ${health.galaxySeed}` : 'server unreachable'}
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: 'fixed',
    inset: 0,
    background: '#0b0e14',
    color: '#d6deeb',
    fontFamily: 'system-ui, sans-serif',
  },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
  hud: {
    position: 'absolute',
    top: '1rem',
    left: '1rem',
    padding: '1rem 1.5rem',
    border: '1px solid #2a3346',
    borderRadius: 12,
    background: 'rgba(17, 21, 31, 0.85)',
  },
  title: { margin: 0, fontSize: '1.4rem', letterSpacing: '0.08em' },
  status: { margin: '0.5rem 0 0', color: '#8b97ab' },
};

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(<App />);
