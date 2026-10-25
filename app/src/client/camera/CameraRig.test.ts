import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from './CameraRig';

describe('CameraRig', () => {
  let rig: CameraRig;
  let mockWorldManager: any;

  beforeEach(() => {
    // Mock window for browser-dependent code
    global.window = {
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener: vi.fn(),
    } as any;

    rig = new CameraRig();
    mockWorldManager = {
      heightAt: vi.fn().mockReturnValue(0),
    };
  });

  it('should clamp on-foot pitch', () => {
    rig.setMode('OnFoot');
    
    // Set pitch to > 80 degrees
    rig.setOnFootRotation(0, (90 * Math.PI) / 180);
    
    const mockPlayer = {
      kind: 'character',
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    
    rig.update(0.016, mockPlayer, mockWorldManager);
    
    const rot = rig.getOnFootRotation();
    expect(rot.pitch).toBeCloseTo((80 * Math.PI) / 180);
  });

  it('should apply exponential smoothing in Cockpit mode', () => {
    rig.setMode('Cockpit');
    const mockPlayer = {
      kind: 'ship',
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    
    rig.update(0.1, mockPlayer, mockWorldManager);
    const pos1 = rig.camera.position.clone();
    
    mockPlayer.pos = { x: 10, y: 0, z: 0 };
    rig.update(0.1, mockPlayer, mockWorldManager);
    const pos2 = rig.camera.position.clone();
    
    expect(pos2.x).toBeGreaterThan(pos1.x);
    expect(pos2.x).toBeLessThan(11.2); // 10 + offset(1.2)
  });

  it('should handle handoff animation duration', () => {
    rig.setMode('Cockpit');
    const shipPlayer = {
      kind: 'ship',
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    rig.update(0, shipPlayer, mockWorldManager);
    
    rig.setMode('OnFoot');
    const charPlayer = {
      kind: 'character',
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    
    // Update for 300ms (halfway)
    rig.update(0.3, charPlayer, mockWorldManager);
    expect((rig as any).isHandoff).toBe(true);
    expect((rig as any).inputLocked).toBe(true);
    
    // Update for another 301ms
    rig.update(0.301, charPlayer, mockWorldManager);
    expect((rig as any).isHandoff).toBe(false);
    expect((rig as any).inputLocked).toBe(false);
  });

  it('should nudge camera position above terrain during handoff', () => {
    rig.setMode('Cockpit');
    const shipPlayer = {
      kind: 'ship',
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    rig.update(0, shipPlayer, mockWorldManager);
    
    rig.setMode('OnFoot');
    const charPlayer = {
      kind: 'character',
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    
    mockWorldManager.heightAt.mockReturnValue(10); // Terrain is at y=10
    
    // Target pose for OnFoot is roughly y=1.6. Path will go through y=10.
    rig.update(0.3, charPlayer, mockWorldManager);
    
    expect(rig.camera.position.y).toBeGreaterThanOrEqual(10);
  });
});
