import * as THREE from 'three';
import { Planet } from '../../shared/galaxy/types';
import { boundaryFactor } from '../../shared/physics/atmosphere';

export class AtmosphereDome {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor() {
    const geometry = new THREE.SphereGeometry(1, 32, 32);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        skyboxColor: { value: new THREE.Color(0x000000) },
        atmosphereColor: { value: new THREE.Color(0x4488ff) },
        haze: { value: 0.0 },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        uniform vec3 skyboxColor;
        uniform vec3 atmosphereColor;
        uniform float haze;
        void main() {
          // Simple atmospheric scattering approximation
          float intensity = pow(0.7 - dot(vNormal, vec3(0, 0, 1.0)), 2.0);
          gl_FragColor = vec4(mix(skyboxColor, atmosphereColor, haze * intensity), 1.0);
        }
      `,
      side: THREE.BackSide,
      transparent: true,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
  }

  update(planet: Planet, planetPos: THREE.Vector3, playerPos: THREE.Vector3, skyboxColor: THREE.Color) {
    const alt = playerPos.distanceTo(planetPos) - planet.radiusKm * 1000;
    const haze = boundaryFactor(alt, planet) * (planet.atmosphereDensity ?? 0);

    if (haze <= 0) {
      this.mesh.visible = false;
      return;
    }

    this.mesh.visible = true;
    this.mesh.position.copy(planetPos);
    
    const atmosphereRadiusM = (planet.radiusKm + planet.atmosphereHeight) * 1000;
    this.mesh.scale.setScalar(atmosphereRadiusM);

    this.material.uniforms.skyboxColor.value.copy(skyboxColor);
    this.material.uniforms.haze.value = haze;
  }

  getMesh() {
    return this.mesh;
  }
}
