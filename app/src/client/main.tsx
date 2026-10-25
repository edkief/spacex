import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Renderer } from './Renderer';
import { OverviewTab } from './OverviewTab';
import { Livery } from '../shared/ships';
import { PlayerList } from './components/PlayerList';
import { ToastStack } from './components/ToastStack';
import { ChatLog } from './components/ChatLog';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { networkManager } from './net/NetworkManager';

const App = () => {
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [callsign, setCallsign] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [livery, setLivery] = useState<Livery>({
    hull: '#cccccc',
    accent: '#ff0000',
    trim: '#333333',
  });

  useEffect(() => {
    const r = new Renderer();
    setRenderer(r);

    fetch('/api/ships')
      .then((res) => {
        if (!res.ok) throw new Error('Not authenticated');
        return res.json();
      })
      .then((data) => {
        if (data.livery) {
          const currentLivery = data.livery;
          setLivery(currentLivery);
          r.updateLivery(currentLivery);
        }
      })
      .catch((err) => {
        console.log('No existing session found, waiting for claim.');
      });
  }, []);

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setClaimError(null);
    try {
      const res = await fetch('/api/callsigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callsign }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to claim callsign');
      }
      setToken(data.token);
      await networkManager.connect(data.token);
    } catch (err: any) {
      setClaimError(err.message);
    }
  };

  const handleLiveryUpdate = (nextLivery: Livery) => {
    setLivery(nextLivery);
    if (renderer) {
      renderer.updateLivery(nextLivery);
    }
  };

  if (!token) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          color: '#fff',
          fontFamily: 'sans-serif',
        }}
      >
        <form onSubmit={handleClaim} style={{ textAlign: 'center', background: '#111', padding: '2rem', borderRadius: '8px', border: '1px solid #333' }}>
          <h2 style={{ marginBottom: '1rem' }}>Claim Your Callsign</h2>
          <input
            value={callsign}
            onChange={(e) => setCallsign(e.target.value)}
            placeholder="CALLSIGN"
            style={{
              padding: '10px',
              fontSize: '1.2rem',
              background: '#000',
              color: '#fff',
              border: '1px solid #444',
              borderRadius: '4px',
              marginBottom: '1rem',
              display: 'block',
              width: '100%',
              boxSizing: 'border-box',
            }}
            required
          />
          {claimError && <p style={{ color: '#ff4444', marginBottom: '1rem' }}>{claimError}</p>}
          <button
            type="submit"
            style={{
              padding: '10px 20px',
              fontSize: '1rem',
              background: '#fff',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              width: '100%',
            }}
          >
            Claim and Enter System
          </button>
        </form>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        overflow: 'hidden',
        background: '#000',
        color: '#fff',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 10, pointerEvents: 'none' }}>
        <h1 style={{ margin: 0 }}>Drift Scaffold</h1>
        <p>React HUD is active.</p>
      </div>

      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 10 }}>
        <OverviewTab initialLivery={livery} onUpdate={handleLiveryUpdate} />
      </div>

      <ChatLog />
      <PlayerList />
      <ToastStack />
      <ConnectionOverlay />

      <canvas id="main-canvas" style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
