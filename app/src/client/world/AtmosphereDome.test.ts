import { describe, it, expect } from 'vitest';
import { AtmosphereDome } from './AtmosphereDome';
import { Planet } from '../../shared/galaxy/types';
import * as THREE from 'three';

describe('AtmosphereDome', () => {
  it('should scale haze with atmosphereDensity', () => {
    const dome = new AtmosphereDome();
    const planetPos = new THREE.Vector3(0, 0, 0);
    const playerPos = new THREE.Vector3(0, 0, 0); // At surface
    const skyboxColor = new THREE.Color(0x000000);

    const planetThin: Planet = {
      id: 'thin',
      radiusKm: 1000,
      atmosphereHeight: 100,
      atmosphereDensity: 0.1,
    };

    const planetThick: Planet = {
      id: 'thick',
      radiusKm: 1000,
      atmosphereHeight: 100,
      atmosphereDensity: 0.8,
    };

    // We need to access the material uniforms to check the haze value.
    // Since AtmosphereDome.material is private, we might need to make it public or add a getter.
    // But for the test, we can just check if the update method works as expected.
    
    // Since we can't easily access the private material, let's check the behavior.
    // Actually, let's just verify the calculation logic if it was exported.
    // But it's inside the update method.
    
    // Let's cast it to any to access private members for the test.
    const domeAny = dome as any;
    
    dome.update(planetThin, planetPos, playerPos, skyboxColor);
    const hazeThin = domeAny.material.uniforms.haze.value;

    dome.update(planetThick, planetPos, playerPos, skyboxColor);
    const hazeThick = domeAny.material.uniforms.haze.value;

    expect(hazeThick).toBeGreaterThan(hazeThin * 1.2);
  });

  it('should hide dome when player is above atmosphere', () => {
    const dome = new AtmosphereDome();
    const planetPos = new THREE.Vector3(0, 0, 0);
    const playerPos = new THREE.Vector3(0, 1200 * 1000, 0); // 1200km from center, above 1100km boundary
    const skyboxColor = new THREE.Color(0x000000);

    const planet: Planet = {
      id: 'p1',
      radiusKm: 1000,
      atmosphereHeight: 100,
      atmosphereDensity: 0.5,
    };

    dome.update(planet, planetPos, playerPos, skyboxColor);
    expect(dome.getMesh().visible).toBe(false);
  });
});
