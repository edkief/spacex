import React, { useEffect, useState } from 'react';
import { presenceStore } from '../net/presence';

interface Toast {
  id: string;
  message: string;
  type: 'join' | 'leave';
}

export const ToastStack: React.FC = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onJoin = ({ player }: { playerId: string; player: any }) => {
      addToast(`${player.callsign} joined`, 'join');
    };
    const onLeave = ({ playerId }: { playerId: string }) => {
      const player = presenceStore.getPlayer(playerId);
      const callsign = player?.callsign || 'Someone';
      addToast(`${callsign} left`, 'leave');
    };

    presenceStore.on('update', onJoin);
    presenceStore.on('leave', onLeave);

    return () => {
      presenceStore.off('update', onJoin);
      presenceStore.off('leave', onLeave);
    };
  }, []);

  const addToast = (message: string, type: 'join' | 'leave') => {
    const id = Math.random().toString(36).substring(2, 11);
    setToasts(prev => {
      const next = [...prev, { id, message, type }];
      return next.slice(-3); // Keep last 3
    });

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  return (
    <div style={{
      position: 'absolute',
      top: '20px',
      right: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      zIndex: 1000,
      pointerEvents: 'none'
    }}>
      {toasts.map(toast => (
        <div key={toast.id} style={{
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '4px',
          fontFamily: 'monospace',
          fontSize: '14px',
          borderLeft: `4px solid ${toast.type === 'join' ? '#4caf50' : '#f44336'}`,
          animation: 'fadeIn 0.3s ease-out',
          whiteSpace: 'nowrap'
        }}>
          {toast.message}
        </div>
      ))}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
};
