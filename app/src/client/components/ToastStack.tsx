import React, { useEffect, useState } from 'react';
import { presenceStore } from '../net/presence';
import { toastStore, ToastType } from '../state/toastStore';

export const ToastStack: React.FC = () => {
  const [toasts, setToasts] = useState(toastStore.toasts);

  useEffect(() => {
    const unsubscribe = toastStore.subscribe(() => {
      setToasts([...toastStore.toasts]);
    });

    const onJoin = ({ player }: { playerId: string; player: any }) => {
      toastStore.addToast(`${player.callsign} joined`, 'success');
    };
    const onLeave = ({ playerId }: { playerId: string }) => {
      const player = presenceStore.getPlayer(playerId);
      const callsign = player?.callsign || 'Someone';
      toastStore.addToast(`${callsign} left`, 'error');
    };

    presenceStore.on('update', onJoin);
    presenceStore.on('leave', onLeave);

    return () => {
      unsubscribe();
      presenceStore.off('update', onJoin);
      presenceStore.off('leave', onLeave);
    };
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        top: '20px',
        right: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        zIndex: 1000,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            padding: '8px 16px',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '14px',
            borderLeft: `4px solid ${
              toast.type === 'success' ? '#4caf50' : toast.type === 'error' ? '#f44336' : '#2196f3'
            }`,
            animation: 'fadeIn 0.3s ease-out',
            whiteSpace: 'nowrap',
          }}
        >
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
