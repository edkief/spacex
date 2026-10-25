import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Renderer } from './Renderer';
import { OverviewTab } from './OverviewTab';
import { Livery } from '../shared/ships';
import { PlayerList } from './components/PlayerList';
import { ToastStack } from './components/ToastStack';
import { ChatLog } from './components/ChatLog';
import { ConnectionOverlay } from './components/ConnectionOverlay';

const App = () => {

  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [livery, setLivery] = useState<Livery>({
    hull: '#cccccc',
    accent: '#ff0000',
    trim: '#333333',
  });

  useEffect(() => {
    const r = new Renderer();
    setRenderer(r);

    // Fetch current ship livery
    fetch('/api/ships')
      .then((res) => res.json())
      .then((data) => {
        if (data.livery) {
          const currentLivery = data.livery;
          setLivery(currentLivery);
          r.updateLivery(currentLivery);
        }
      })
      .catch((err) => console.error('Failed to fetch ship livery:', err));
  }, []);

  const handleLiveryUpdate = (nextLivery: Livery) => {
    setLivery(nextLivery);
    if (renderer) {
      renderer.updateLivery(nextLivery);
    }
  };

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
