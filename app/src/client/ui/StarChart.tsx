import React, { useEffect, useState } from 'react';
import { systemStore } from '../state/systemStore';
import { warpStore } from '../state/warpStore';
import { SystemChartNode } from '../../shared/galaxy/travel';

const SPECTRAL_COLORS: Record<string, string> = {
  O: '#9bb2ff',
  B: '#bbccff',
  A: '#ffffff',
  F: '#ffffcc',
  G: '#ffffaa',
  K: '#ffcc88',
  M: '#ff8888',
};

export const StarChart = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const [data, setData] = useState<SystemChartNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [occupancy, setOccupancy] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const currentSystemId = systemStore.currentSystemId;
  const warpState = warpStore.state;

  useEffect(() => {
    if (!isOpen) return;

    // Fetch galaxy overview
    fetch('/api/galaxy/overview')
      .then((res) => res.json())
      .then((data) => {
        setData(data);
        setLoading(false);
      })
      .catch((err) => console.error('Failed to fetch star chart data:', err));

    // Poll occupancy every 5s
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/galaxy/health');
        const stats = await res.json();

        const newOccupancy: Record<string, number> = {};
        if (Array.isArray(stats.shards)) {
          for (const shard of stats.shards) {
            newOccupancy[shard.systemId] = shard.players || 0;
          }
        }
        setOccupancy(newOccupancy);
      } catch (err) {
        console.error('Failed to poll occupancy:', err);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  if (loading) {
    return (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0,0,0,0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          zIndex: 100,
          cursor: 'default',
          fontFamily: 'sans-serif',
        }}
      >
        Loading Galaxy...
      </div>
    );
  }

  const selectedNode = data.find((n) => n.systemId === selectedId);
  const currentSystem = data.find((n) => n.systemId === currentSystemId);

  const handleWarp = () => {
    if (selectedId && selectedId !== currentSystemId) {
      warpStore.setState('warping-in', selectedId);
      // In a real app, this would trigger the WS warp message.
      // For now, we just set the state as per spec.
      console.log(`Warping to ${selectedId}...`);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0,0,0,0.9)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        zIndex: 100,
        fontFamily: 'sans-serif',
        cursor: 'default',
      }}
    >
      <div style={{ position: 'absolute', top: 20, right: 20 }}>
        <button
          onClick={onClose}
          style={{
            background: '#333',
            color: '#fff',
            border: '1px solid #555',
            padding: '8px 16px',
            cursor: 'pointer',
            borderRadius: '4px',
          }}
        >
          Close (Esc)
        </button>
      </div>

      <div
        style={{
          position: 'relative',
          width: 800,
          height: 500,
          border: '1px solid #333',
          background: '#050505',
        }}
      >
        <svg width="800" height="500" viewBox="0 0 800 500" style={{ display: 'block' }}>
          {/* Edges */}
          {data.map((node) => (
            <g key={`edges-${node.systemId}`}>
              {node.neighbors.map((edge) => {
                const target = data.find((n) => n.systemId === edge.to);
                if (!target) return null;
                return (
                  <g key={`edge-${node.systemId}-${edge.to}`}>
                    <line
                      x1={node.pos2D.x}
                      y1={node.pos2D.y}
                      x2={target.pos2D.x}
                      y2={target.pos2D.y}
                      stroke="#222"
                      strokeWidth="1"
                    />
                    <text
                      x={(node.pos2D.x + target.pos2D.x) / 2}
                      y={(node.pos2D.y + target.pos2D.y) / 2}
                      fill="#666"
                      fontSize="10"
                      textAnchor="middle"
                      dy="-5"
                    >
                      {edge.distance.toFixed(0)}ls / {edge.warpTime}s
                    </text>
                  </g>
                );
              })}
            </g>
          ))}

          {/* Nodes */}
          {data.map((node) => (
            <g
              key={node.systemId}
              onClick={() => setSelectedId(node.systemId)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={node.pos2D.x}
                cy={node.pos2D.y}
                r={selectedId === node.systemId ? 6 : 4}
                fill={SPECTRAL_COLORS[node.starClass] || '#fff'}
                stroke={node.systemId === currentSystemId ? '#00ff00' : 'none'}
                strokeWidth="2"
              />
              <text
                x={node.pos2D.x}
                y={node.pos2D.y}
                fill="#aaa"
                fontSize="12"
                textAnchor="middle"
                dy="18"
              >
                {node.name}
              </text>
              {occupancy[node.systemId] > 0 && (
                <g transform={`translate(${node.pos2D.x + 6}, ${node.pos2D.y - 6})`}>
                  <rect width="16" height="12" rx="2" fill="#444" stroke="#666" />
                  <text x="8" y="9" fill="#fff" fontSize="9" textAnchor="middle" fontWeight="bold">
                    {occupancy[node.systemId]}
                  </text>
                </g>
              )}
            </g>
          ))}
        </svg>
      </div>

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        {selectedNode && (
          <div style={{ marginBottom: 10 }}>
            Selected:{' '}
            <span style={{ color: SPECTRAL_COLORS[selectedNode.starClass] }}>
              {selectedNode.name}
            </span>
          </div>
        )}

        <button
          disabled={!selectedId || selectedId === currentSystemId || warpState !== 'idle'}
          onClick={handleWarp}
          style={{
            padding: '12px 24px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
            background:
              !selectedId || selectedId === currentSystemId || warpState !== 'idle'
                ? '#333'
                : '#fff',
            color:
              !selectedId || selectedId === currentSystemId || warpState !== 'idle'
                ? '#666'
                : '#000',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          {warpState === 'warping-in' ? 'Warping...' : 'Warp'}
        </button>
      </div>
    </div>
  );
};
