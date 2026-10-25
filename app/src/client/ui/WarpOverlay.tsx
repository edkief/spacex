import React from 'react';
import { warpStore } from '../state/warpStore';

export const WarpOverlay: React.FC = () => {
  const state = warpStore.state;

  if (state === 'idle') return null;

  return (
    <div data-testid="warp-overlay" style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 1000,
      pointerEvents: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      backgroundColor: state === 'awaiting' ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.5)',
      transition: 'background-color 0.5s ease',
    }}>
      {(state === 'warping-in' || state === 'warping-out') && (
        <div style={{
          position: 'absolute',
          width: '200%',
          height: '200%',
          backgroundImage: 'radial-gradient(circle, transparent 20%, rgba(255,255,255,0.6) 21%, transparent 22%)',
          backgroundSize: '100px 100px',
          animation: state === 'warping-in' 
            ? 'warp-in 2s ease-in forwards' 
            : 'warp-out 2s ease-out forwards',
        }} />
      )}
      {state === 'awaiting' && (
        <div style={{
          color: 'white',
          fontSize: '24px',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          letterSpacing: '4px',
        }}>
          Calculating Jump...
        </div>
      )}
      <style>{`
        @keyframes warp-in {
          0% { transform: scale(1); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: scale(0.1); opacity: 0; }
        }
        @keyframes warp-out {
          0% { transform: scale(0.1); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
      `}</style>
    </div>
  );
};
