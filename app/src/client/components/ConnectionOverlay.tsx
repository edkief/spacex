import React from 'react';
import { connectionStore } from '../net/connection-store';

export const ConnectionOverlay = () => {
  const [status, setStatus] = React.useState(connectionStore.status);
  const [error, setError] = React.useState(connectionStore.error);

  React.useEffect(() => {
    return connectionStore.subscribe((s, e) => {
      setStatus(s);
      setError(e);
    });
  }, []);

  if (status === 'connected') return null;

  const isBlocking = status === 'disconnected';

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: isBlocking ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        color: '#fff',
        fontFamily: 'sans-serif',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }}>
          {status === 'connecting' && 'Connecting...'}
          {status === 'reconnecting' && 'Connection Lost. Reconnecting...'}
          {status === 'disconnected' && 'Disconnected'}
        </h2>
        {error && <p style={{ color: '#ff4444', marginBottom: '2rem' }}>{error}</p>}
        {status === 'disconnected' && (
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 24px',
              fontSize: '1rem',
              backgroundColor: '#fff',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            Retry Connection
          </button>
        )}
      </div>
    </div>
  );
};
