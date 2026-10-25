import * as THREE from 'three';
import { generateSystem } from '../../shared/galaxy/system';
import { ChunkManager } from './chunks';
import { ChunkScene } from './ChunkScene';
import { planetWorldPosition } from '../../shared/galaxy/regime-planets';
import { padsFor } from '../../shared/world/pads';

export class WorldManager {
  private scene: THREE.Scene;
  private worldObjects: THREE.Group = new THREE.Group();
  private currentSystemId: string | null = null;
  private currentSystem: any = null; // Store the generated system
  private chunkManager: ChunkManager | null = null;
  private chunkScene: ChunkScene | null = null;
  private systemSeed: string = 'dev-seed'; // Should be dynamic in real app

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
    this.systemSeed = seed;

    // Create a new group for the new world to avoid clearing the scene immediately
    const newWorldObjects = new THREE.Group();

    try {
      const system = generateSystem(seed, systemId);
      this.currentSystem = system;
      
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
      starMesh.position.set(0, 0, 8000); // STAR_SYSTEM_OFFSET_M
      newWorldObjects.add(starMesh);

      // 2. Create Planets (placeholder LODs)
      system.planets.forEach((planet, index) => {
        const planetGeo = new THREE.SphereGeometry(2, 32, 32);
        const planetMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
        const planetMesh = new THREE.Mesh(planetGeo, planetMat);
        
        // Deterministic placement based on orbit radius and index
        const pos = planetWorldPosition(seed, systemId, index);
        planetMesh.position.set(pos.x, pos.y, pos.z);
        newWorldObjects.add(planetMesh);
      });

      // 3. Landing Pads
      const pads = padsFor(seed, systemId);
      const ringGeo = new THREE.RingGeometry(19, 20, 32);
      const ringMat = new THREE.MeshBasicMaterial({ 
        color: 0x00ff00, 
        side: THREE.DoubleSide, 
        transparent: true, 
        opacity: 0.5 
      });
      pads.forEach(pad => {
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(pad.pos.x, pad.pos.y, pad.pos.z);
        ring.rotation.set(-Math.PI / 2, 0, 0); // Lay flat
        newWorldObjects.add(ring);
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

  public getNearestPlanet(pos: THREE.Vector3): { planet: Planet; pos: THREE.Vector3 } | null {
    if (!this.currentSystem || !this.currentSystemId) return null;
    
    let nearest: { planet: Planet; pos: THREE.Vector3 } | null = null;
    let minDist = Infinity;
    
    this.currentSystem.planets.forEach((planet: Planet, i: number) => {
      const planetPos = planetWorldPosition(this.systemSeed, this.currentSystemId!, i);
      const planetPosVec = new THREE.Vector3(planetPos.x, planetPos.y, planetPos.z);
      const dist = pos.distanceTo(planetPosVec);
      if (dist < minDist) {
        minDist = dist;
        nearest = { planet, pos: planetPosVec };
      }
    });
    
    return nearest;
  }

  public update(playerPos: THREE.Vector3, velocity: THREE.Vector3) {
    if (!this.chunkManager || !this.chunkScene) return;

    this.chunkManager.updateScheduler();
    this.chunkScene.update(playerPos);
  }
}
