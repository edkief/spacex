import React, { useEffect, useState } from 'react';
import { Renderer } from '../Renderer';
import { frameMonitor, FrameStats } from '../perf/frameMonitor';

interface DebugOverlayProps {
  renderer: Renderer | null;
}

export const DebugOverlay: React.FC<DebugOverlayProps> = ({ renderer }) => {
  const [visible, setVisible] = useState(false);
  const [stats, setStats] = useState<FrameStats | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        setVisible((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!visible || !renderer) return;

    const interval = setInterval(() => {
      const currentStats = frameMonitor.getFrameStats(
        renderer.renderer.info,
        renderer.ships.size
      );
      setStats(currentStats);
    }, 500);

    return () => clearInterval(interval);
  }, [visible, renderer]);

  if (!import.meta.env.DEV || !visible) return null;

  return (
    <div
      data-testid="debug-overlay"
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        background: 'rgba(0, 0, 0, 0.8)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: '12px',
        padding: '10px',
        borderRadius: '4px',
        border: '1px solid #0f0',
        zIndex: 100,
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: '4px', borderBottom: '1px solid #0f0' }}>
        PERF MONITOR
      </div>
      {stats ? (
        <div>
          FPS: {stats.fps.toFixed(1)}<br />
          p50: {stats.p50.toFixed(2)}ms<br />
          p95: {stats.p95.toFixed(2)}ms<br />
          p99: {stats.p99.toFixed(2)}ms<br />
          Calls: {stats.drawCalls}<br />
          Tris: {stats.triangles}<br />
          Ents: {stats.entities}
        </div>
      ) : (
        'Collecting stats...'
      )}
    </div>
  );
};
