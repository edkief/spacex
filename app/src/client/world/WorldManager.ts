import * as THREE from 'three';
import { generateSystem } from '../../shared/galaxy/system';
import { ChunkManager } from './chunks';
import { ChunkScene } from './ChunkScene';

export class WorldManager {
  private scene: THREE.Scene;
  private worldObjects: THREE.Group = new THREE.Group();
  private currentSystemId: string | null = null;
  private chunkManager: ChunkManager | null = null;
  private chunkScene: ChunkScene | null = null;

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

    // Create a new group for the new world to avoid clearing the scene immediately
    const newWorldObjects = new THREE.Group();

    try {
      const system = generateSystem(seed, systemId);
      
      // Setup chunking for the first landable planet
      const landablePlanet = system.planets.find(p => p.landable);
      if (landablePlanet) {
        this.chunkManager = new ChunkManager(seed, landablePlanet);
        this.chunkScene = new ChunkScene(this.scene, this.chunkManager);
      }

      // 1. Create Star
      const starGeo = new THREE.SphereGeometry(10, 32, 32);
      const starMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
      const starMesh = new THREE.Mesh(starGeo, starMat);
      newWorldObjects.add(starMesh);

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
        newWorldObjects.add(planetMesh);
      });

      // Atomic swap: remove old, add new
      const oldWorld = this.worldObjects;
      this.scene.remove(oldWorld);
      this.clearWorld(oldWorld);
      
      this.worldObjects = newWorldObjects;
      this.scene.add(this.worldObjects);

      this.currentSystemId = systemId;
      
      const duration = performance.now() - startTime;
      console.log(`[WorldManager] World swap for ${systemId} took ${duration.toFixed(2)}ms`);
    } catch (e) {
      console.error(`[WorldManager] Failed to load world ${systemId}:`, e);
    }
  }

  private clearWorld(group: THREE.Group = this.worldObjects) {
    group.children.forEach((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          (obj.material as any).dispose();
        }
      }
    });
    group.clear();
  }

  public heightAt(x: number, z: number): number {
    if (!this.chunkManager) return 0;
    return this.chunkManager.getHeightAt(x, z);
  }

  public update(playerPos: THREE.Vector3, velocity: THREE.Vector3) {
    if (!this.chunkManager || !this.chunkScene) return;

    this.chunkManager.updateScheduler();
    this.chunkScene.update(playerPos);
  }
}
