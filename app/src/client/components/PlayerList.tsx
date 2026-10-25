import React, { useEffect, useState } from 'react';
import { presenceStore, PresencePlayer } from '../net/presence';

export const PlayerList: React.FC<{ localCallsign: string }> = ({ localCallsign }) => {
  const [players, setPlayers] = useState<Map<string, PresencePlayer>>(new Map());

  useEffect(() => {
    const update = () => setPlayers(presenceStore.getPlayers());

    presenceStore.on('update', update);
    presenceStore.on('leave', update);
    presenceStore.on('clear', update);

    // Initial load
    update();

    return () => {
      presenceStore.off('update', update);
      presenceStore.off('leave', update);
      presenceStore.off('clear', update);
    };
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        color: '#ccc',
        padding: '10px',
        borderRadius: '4px',
        fontFamily: 'monospace',
        fontSize: '12px',
        zIndex: 1000,
        pointerEvents: 'none',
        minWidth: '120px',
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: '5px', borderBottom: '1px solid #555' }}>
        SYSTEM PRESENCE
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ color: '#fff' }}>
          <span style={{ marginRight: '8px' }}>●</span>
          <span>{localCallsign || '(you)'}</span>
        </div>
        {Array.from(players.values()).map((player, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
            <span
              style={{
                marginRight: '8px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: player.onFoot ? '#ffeb3b' : '#4caf50',
              }}
            />
            <span>{player.callsign}</span>
          </div>
        ))}
        {players.size === 0 && <div style={{ opacity: 0.5 }}>No other players</div>}
      </div>
    </div>
  );
};
