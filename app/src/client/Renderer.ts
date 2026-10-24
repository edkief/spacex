import * as THREE from 'three';
import { ShipMeshBuilder } from './ShipMeshBuilder';
import { Livery, ShipClassId } from '../shared/ships';

export class Renderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  private renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('main-canvas') as HTMLCanvasElement,
    antialias: true,
  });
  private shipBuilder = new ShipMeshBuilder();
  private shipMesh: THREE.Group;

  constructor() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    const ambientLight = new THREE.AmbientLight(0x404040);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    this.camera.position.z = 5;
    this.camera.position.y = 2;
    this.camera.lookAt(0, 0, 0);

    // Create a default ship for now (scout)
    this.shipMesh = this.shipBuilder.build('scout');
    this.shipBuilder.applyDefaultLivery('scout');
    this.scene.add(this.shipMesh);

    window.addEventListener('resize', () => this.onResize());
    this.animate();
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  updateLivery(livery: Livery) {
    this.shipBuilder.applyLivery(livery);
  }

  private animate = () => {
    requestAnimationFrame(this.animate);

    this.shipMesh.rotation.y += 0.01;

    this.renderer.render(this.scene, this.camera);
  };
}
