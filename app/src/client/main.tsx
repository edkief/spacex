import React from 'react';
import ReactDOM from 'react-dom/client';

const App = () => {
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
        <h1>Drift Scaffold</h1>
        <p>React HUD is active.</p>
      </div>
      <canvas id="main-canvas" style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
