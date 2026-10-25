import * as THREE from 'three';
import { ChunkManager, ChunkKey, ChunkGeometries } from './chunks';
import { Biome } from '../../shared/galaxy/types';
import { frameMonitor } from '../perf/frameMonitor';

const BIOME_COLORS: Record<Biome, number> = {
  plains: 0x7cfc00,
  rock: 0x808080,
  canyon: 0xcd853f,
  frozen: 0xffffff,
  wetland: 0x228b22,
};

export class ChunkScene {
  private chunkMeshes = new Map<ChunkKey, THREE.Mesh>();
  private materials = new Map<Biome, THREE.MeshStandardMaterial>();

  constructor(
    private scene: THREE.Scene,
    private chunkManager: ChunkManager
  ) {
    // Pre-create materials for each biome
    for (const [biome, color] of Object.entries(BIOME_COLORS)) {
      this.materials.set(biome as Biome, new THREE.MeshStandardMaterial({ color }));
    }
  }

  public update(playerPos: THREE.Vector3) {
    const activeKeys = this.chunkManager.update(playerPos, new THREE.Vector3(0, 0, 0)); // velocity simplified for now
    
    let totalTris = 0;
    let nearTris = 0;
    let midTris = 0;
    let farTris = 0;

    // 1. Remove inactive chunks
    for (const [key, mesh] of this.chunkMeshes) {
      if (!activeKeys.has(key)) {
        this.scene.remove(mesh);
        this.chunkMeshes.delete(key);
        // Geometry is managed by ChunkManager's cache/LRU
      }
    }

    // 2. Add or update active chunks
    for (const key of activeKeys) {
      const geoData = this.chunkManager.getGeometry(key);
      if (!geoData) continue;

      const [cx, cz] = key.split(',').map(Number);
      const chunkWorldPos = new THREE.Vector3(cx * 512, 0, cz * 512);
      const dist = playerPos.distanceTo(chunkWorldPos);

      // Determine LOD
      let geometry: THREE.BufferGeometry;
      if (dist < 512) {
        geometry = geoData.near;
        nearTris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
      } else if (dist < 2048) {
        geometry = geoData.mid;
        midTris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
      } else {
        geometry = geoData.far;
        farTris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
      }

      const material = this.materials.get(geoData.biome)!;
      
      let mesh = this.chunkMeshes.get(key);
      if (!mesh) {
        mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(chunkWorldPos);
        this.scene.add(mesh);
        this.chunkMeshes.set(key, mesh);
      } else {
        if (mesh.geometry !== geometry) {
          mesh.geometry = geometry;
        }
      }
    }

    totalTris = nearTris + midTris + farTris;
    frameMonitor.setTriangleCount('surface-near', nearTris);
    frameMonitor.setTriangleCount('surface-mid', midTris);
    frameMonitor.setTriangleCount('surface-far', farTris);
    frameMonitor.setTriangleCount('surface-tris', totalTris);
    frameMonitor.budgetCheck('surface-tris', totalTris, 400000);
  }

  public dispose() {
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
    }
    this.chunkMeshes.clear();
    for (const mat of this.materials.values()) {
      mat.dispose();
    }
    this.materials.clear();
  }
}
