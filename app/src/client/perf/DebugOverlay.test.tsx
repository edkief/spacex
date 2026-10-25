import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebugOverlay } from './ui/DebugOverlay';
import { Renderer } from '../Renderer';
import { frameMonitor } from '../perf/frameMonitor';

// Mock Renderer
class MockRenderer {
  renderer = {
    info: {
      render: {
        calls: 100,
        triangles: 5000,
      },
    },
  };
  ships = new Map();
}

describe('DebugOverlay Component', () => {
  it('renders performance stats when visible and dev mode is on', async () => {
    // Mock import.meta.env.DEV
    vi.stubGlobal('import', { meta: { env: { DEV: true } } });
    
    const mockRenderer = new MockRenderer() as unknown as Renderer;
    
    // Force visible via F3 simulation or by modifying the component to accept a visible prop for testing.
    // Since I used internal state, I'll trigger F3.
    
    // Let's modify DebugOverlay to accept an initialVisible prop for easier testing.
    // Or just use fireEvent.
  });
});
