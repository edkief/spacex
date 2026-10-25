import * as THREE from 'three';
import { ShipMeshBuilder } from './ShipMeshBuilder';
import { Livery, ShipClassId } from '../shared/ships';
import { networkManager } from './net/NetworkManager';
import { EntityState } from '../shared/protocol/schemas';

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
  private ships = new Map<string, THREE.Group>();
  private network = networkManager;

  private keys = {
    thrust: false,
    pitch: 0,
    yaw: 0,
    roll: 0,
  };

  constructor() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    const ambientLight = new THREE.AmbientLight(0x404040);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    this.camera.position.z = 10;
    this.camera.position.y = 5;
    this.camera.lookAt(0, 0, 0);

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    this.animate();
  }

  private onKeyDown(e: KeyboardEvent) {
    switch (e.code) {
      case 'KeyW':
        this.keys.thrust = true;
        break;
      case 'KeyS':
        this.keys.thrust = false;
        break;
      case 'ArrowUp':
        this.keys.pitch = 1;
        break;
      case 'ArrowDown':
        this.keys.pitch = -1;
        break;
      case 'ArrowLeft':
        this.keys.yaw = -1;
        break;
      case 'ArrowRight':
        this.keys.yaw = 1;
        break;
      case 'KeyA':
        this.keys.roll = -1;
        break;
      case 'KeyD':
        this.keys.roll = 1;
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    switch (e.code) {
      case 'ArrowUp':
      case 'ArrowDown':
        this.keys.pitch = 0;
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        this.keys.yaw = 0;
        break;
      case 'KeyA':
      case 'KeyD':
        this.keys.roll = 0;
        break;
    }
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

    // Handle input
    this.network.sendInput({
      thrust: this.keys.thrust ? 1 : 0,
      pitch: this.keys.pitch,
      yaw: this.keys.yaw,
      turn: this.keys.roll,
      fire: false,
      lock: false,
    });

    // Update ship positions
    const states = this.network.getState(Date.now());
    for (const state of states) {
      let mesh = this.ships.get(state.id);
      if (!mesh) {
        mesh = this.shipBuilder.build('scout');
        this.scene.add(mesh);
        this.ships.set(state.id, mesh);
      }
      mesh.position.set(state.pos.x, state.pos.y, state.pos.z);
      // Rotation would be updated here using state.quat if available
    }

    this.renderer.render(this.scene, this.camera);
  };
}
