import * as THREE from 'three';
import { ChunkManager, getChunkKey, generateChunkGeometries } from './chunks';
import { Planet } from '../../shared/galaxy/types';

describe('World Streaming Chunks', () => {
  const mockPlanet: Planet = {
    id: 'p-1',
    name: 'Test Planet',
    radiusKm: 1000,
    landable: true,
    resourceTypes: ['Iron', 'Silica'],
    // ... add other required properties if any
  } as any;
  const seed = 'test-seed';

  test('chunkKey math', () => {
    expect(getChunkKey(0, 0)).toBe('0,0');
    expect(getChunkKey(-1, 2)).toBe('-1,2');
  });

  test('LOD ring selection', () => {
    const manager = new ChunkManager(seed, mockPlanet);
    const playerPos = new THREE.Vector3(0, 0, 0);
    const velocity = new THREE.Vector3(0, 0, 0);
    
    const activeKeys = manager.update(playerPos, velocity);
    // Manhattan distance <= 2: 1 + 4 + 8 = 13 chunks.
    expect(activeKeys.size).toBe(13); 
  });

  test('Fast movement active set expansion', () => {
    const manager = new ChunkManager(seed, mockPlanet);
    const playerPos = new THREE.Vector3(0, 0, 0);
    const velocity = new THREE.Vector3(200, 0, 0); // Speed > 100
    
    const activeKeys = manager.update(playerPos, velocity);
    // Manhattan distance <= 3: 1 + 4 + 8 + 12 = 25 chunks.
    expect(activeKeys.size).toBe(25);
  });

  test('LRU eviction', () => {
    const manager = new ChunkManager(seed, mockPlanet);
    const playerPos = new THREE.Vector3(0, 0, 0);
    const velocity = new THREE.Vector3(0, 0, 0);
    
    // Fill cache just above limit (400)
    for (let i = 0; i < 410; i++) {
      manager.update(new THREE.Vector3(i * 1000, 0, 0), velocity);
      manager.updateScheduler(); 
    }

    // Verify it doesn't crash and still functions
    const activeKeys = manager.update(new THREE.Vector3(0, 0, 0), velocity);
    expect(activeKeys.size).toBe(13);
  }, 30000);

  test('Triangle budget', () => {
    const geo = generateChunkGeometries(seed, mockPlanet, 0, 0);
    const nearTris = (geo.near.index ? geo.near.index.count : geo.near.attributes.position.count) / 3;
    const midTris = (geo.mid.index ? geo.mid.index.count : geo.mid.attributes.position.count) / 3;
    const farTris = (geo.far.index ? geo.far.index.count : geo.far.attributes.position.count) / 3;
    
    console.log(`Triangles - Near: ${nearTris}, Mid: ${midTris}, Far: ${farTris}`);
    
    // 13 chunks at default LOD (assuming a mix)
    // If 13 chunks are all Near: 13 * 7938 = 103k < 400k.
    expect(nearTris * 13).toBeLessThan(400000);
  });
});
