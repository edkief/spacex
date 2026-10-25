import { generateStars } from '../shared/galaxy/stars';
import { generateSystem } from '../shared/galaxy/system';
import { generateSurfaceChunk } from '../shared/galaxy/surface';

export function initDriftDebug() {
  if (!import.meta.env.DEV) return;

  (window as any).__DRIFT__ = {
    requestGalaxySeed: async () => {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error('Health check failed');
      const data = await res.json();
      return data.galaxySeed;
    },
    regenerateStarChart: (seed: string) => {
      return generateStars(seed);
    },
    regenerateSystem: (seed: string, starId: string) => {
      return generateSystem(seed, starId);
    },
    regenerateSurfaceChunk: (seed: string, planet: any, cx: number, cz: number) => {
      return generateSurfaceChunk(seed, planet, cx, cz);
    },
    teleport: async (x: number, y: number, z: number) => {
      const token = localStorage.getItem('drift_token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/debug/teleport', {
        method: 'POST',
        headers,
        body: JSON.stringify({ x, y, z }),
      });
      return res.json();
    },
    teleportToPad: async () => {
      const token = localStorage.getItem('drift_token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/debug/teleport-to-pad', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      return res.json();
    },
  };
}
