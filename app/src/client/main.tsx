import React, { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { Renderer } from './Renderer';
import { OverviewTab } from './OverviewTab';
import { Livery } from '../shared/ships';
import { PlayerList } from './components/PlayerList';
import { ToastStack } from './components/ToastStack';
import { ChatLog } from './components/ChatLog';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { StarChart } from './ui/StarChart';
import { WarpOverlay } from './ui/WarpOverlay';
import { DebugOverlay } from './ui/DebugOverlay';
import { networkManager } from './net/NetworkManager';
import { warpStore } from './state/warpStore';
import { toastStore } from './state/toastStore';
import { initDriftDebug } from './driftDebug';

import { DEFAULT_GALAXY_SEED } from '../shared/galaxy/config';
initDriftDebug();

const DockedIndicator = ({ docked }: { docked: boolean }) => {
  if (!docked) return null;
  return (
    <div style={{
      position: 'absolute',
      bottom: 100,
      left: '50%',
      transform: 'translateX(-50%)',
      color: '#00ff00',
      fontSize: '2rem',
      fontWeight: 'bold',
      textShadow: '0 0 10px #00ff00',
      zIndex: 10,
      pointerEvents: 'none',
    }}>
      DOCKED
    </div>
  );
};

const App = () => {
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [callsign, setCallsign] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [isDocked, setIsDocked] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const galaxySeedRef = useRef(DEFAULT_GALAXY_SEED);
  const [livery, setLivery] = useState<Livery>({
    hull: '#cccccc',
    accent: '#ff0000',
    trim: '#333333',
  });
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [warpState, setWarpState] = useState(warpStore.state);

  useEffect(() => {
    const unsubscribe = warpStore.subscribe(() => {
      setWarpState(warpStore.state);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (data.galaxySeed) {
          galaxySeedRef.current = data.galaxySeed;
        }
      })
      .catch((err) => console.error('Failed to fetch galaxy seed:', err));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'm') {
        setIsChartOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    // Warp Coordination Logic
    if (warpState === 'warping-in' && warpStore.targetSystemId) {
      const timer = setTimeout(() => {
        setIsChartOpen(false);
        networkManager.sendWarp(warpStore.targetSystemId!);
        warpStore.setState('awaiting');
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [warpState]);

  useEffect(() => {
    fetch('/api/ships')
      .then((res) => {
        if (!res.ok) throw new Error('Not authenticated');
        return res.json();
      })
      .then((data) => {
        if (data.livery) {
          setLivery(data.livery);
        }
      })
      .catch((err) => {
        console.log('No existing session found, waiting for claim.');
      });
  }, []);

  useEffect(() => {
    if (!token || !canvasRef.current) return;

    const r = new Renderer(canvasRef.current);
    setRenderer(r);
    r.updateLivery(livery);

    // Handle warp arrival
    networkManager.onWarpArrived = async (data: any) => {
      const { systemId } = data;
      if (r) {
        await r.loadWorld(systemId, galaxySeedRef.current);
      }
      warpStore.setState('warping-out');
      
      setTimeout(() => {
        warpStore.setState('idle');
      }, 2000);
    };

    networkManager.onError = (code, message) => {
      if (code === 'system-full') {
        warpStore.setState('idle');
        toastStore.addToast(message || 'Target system is full', 'error');
      }
    };

    networkManager.onStateUpdate = (data: any) => {
      if (data.state === 'docked') {
        setIsDocked(true);
      } else if (data.state === 'undocked') {
        setIsDocked(false);
      }
    };
  }, [token]);

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
        <form
          onSubmit={handleClaim}
          style={{
            textAlign: 'center',
            background: '#111',
            padding: '2rem',
            borderRadius: '8px',
            border: '1px solid #333',
          }}
        >
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
        <button
          onClick={() => setIsChartOpen(true)}
          style={{
            marginTop: '10px',
            width: '300px',
            padding: '10px',
            background: '#222',
            color: '#fff',
            border: '1px solid #444',
            borderRadius: '8px',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          Open Star Chart (M)
        </button>
      </div>

      <ChatLog />
      <PlayerList localCallsign={callsign} />
      <ToastStack />
      <ConnectionOverlay />
      <StarChart isOpen={isChartOpen} onClose={() => setIsChartOpen(false)} />
      <WarpOverlay />
      <DebugOverlay renderer={renderer} />
       <DockedIndicator docked={isDocked} />
      
      <canvas
        ref={canvasRef}
        id="main-canvas"
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      <div
        id="reentry-tint"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          boxShadow: 'inset 0 0 100px rgba(255, 140, 0, 0.5)',
          background: 'radial-gradient(circle, transparent 60%, rgba(255, 69, 0, 0.2) 100%)',
          opacity: 0,
          transition: 'opacity 0.5s ease',
          zIndex: 5,
        }}
      />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
