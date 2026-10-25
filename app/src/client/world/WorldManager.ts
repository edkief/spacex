import * as THREE from 'three';
import { generateSystem } from '../../shared/galaxy/system';

export class WorldManager {
  private scene: THREE.Scene;
  private worldObjects: THREE.Group = new THREE.Group();
  private currentSystemId: string | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.scene.add(this.worldObjects);
  }

  /**
   * Loads a new world based on the systemId and galaxy seed.
   * Disposes of old assets and builds a new scene.
   */
  public async loadWorld(systemId: string, seed: string): Promise<void> {
    const startTime = performance.now();

    this.clearWorld();

    try {
      const system = generateSystem(seed, systemId);
      
      // 1. Create Star
      const starGeo = new THREE.SphereGeometry(10, 32, 32);
      const starMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
      const starMesh = new THREE.Mesh(starGeo, starMat);
      this.worldObjects.add(starMesh);

      // 2. Create Planets (placeholder LODs)
      system.planets.forEach((planet, index) => {
        const planetGeo = new THREE.SphereGeometry(2, 32, 32);
        const planetMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
        const planetMesh = new THREE.Mesh(planetGeo, planetMat);
        
        // Deterministic placement based on orbit radius and index
        const orbitRadius = 50 + index * 30;
        const angle = (index / system.planets.length) * Math.PI * 2;
        planetMesh.position.set(
          Math.cos(angle) * orbitRadius,
          0,
          Math.sin(angle) * orbitRadius
        );
        this.worldObjects.add(planetMesh);
      });

      this.currentSystemId = systemId;
      
      const duration = performance.now() - startTime;
      console.log(`[WorldManager] World swap for ${systemId} took ${duration.toFixed(2)}ms`);
    } catch (e) {
      console.error(`[WorldManager] Failed to load world ${systemId}:`, e);
    }
  }

  private clearWorld() {
    this.worldObjects.children.forEach((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          (obj.material as any).dispose();
        }
      }
    });
    this.worldObjects.clear();
  }

  public getCurrentSystemId(): string | null {
    return this.currentSystemId;
  }
}
