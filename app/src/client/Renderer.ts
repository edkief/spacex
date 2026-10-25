import * as THREE from 'three';
import { ShipMeshBuilder } from './ShipMeshBuilder';
import { Livery, ShipClassId } from '../shared/ships';
import { networkManager } from './net/NetworkManager';
import { EntityState } from '../shared/protocol/schemas';
import { WorldManager } from './world/WorldManager';
import { AtmosphereDome } from './world/AtmosphereDome';
import { frameMonitor } from './perf/frameMonitor';
import { getControlScheme, ControlAxis } from './input/controls';
import { FlightRegime } from '../shared/physics/types';
import { CameraRig } from './camera/CameraRig';

export class Renderer {
  private scene = new THREE.Scene();
  private cameraRig = new CameraRig();
  public renderer: THREE.WebGLRenderer;
  private shipBuilder = new ShipMeshBuilder();
  private worldManager = new WorldManager(this.scene);
  private atmosphereDome = new AtmosphereDome();
  public ships = new Map<string, THREE.Group>();
  private network = networkManager;

  private currentRegime: FlightRegime = 'space';
  private keys: Record<string, any> = {
    thrust: false,
    pitch: 0,
    yaw: 0,
    roll: 0,
    up: 0,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    const ambientLight = new THREE.AmbientLight(0x404040);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    this.scene.add(this.atmosphereDome.getMesh());

    this.animate();
  }

  private onKeyDown(e: KeyboardEvent) {
    const scheme = getControlScheme(this.currentRegime);
    const mapping = scheme.mapKey(e.code);
    if (mapping) {
      if (mapping.axis === 'thrust') {
        this.keys.thrust = mapping.value === 1;
      } else {
        this.keys[mapping.axis] = mapping.value;
      }
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    const scheme = getControlScheme(this.currentRegime);
    const mapping = scheme.mapKey(e.code);
    if (mapping) {
      if (mapping.axis === 'thrust') {
        // This is a bit tricky; S sets thrust to false, but what does keyUp do?
        // In the old code, KeyW set it to true, KeyS to false.
        // Let's just keep it as is or reset to a default.
      } else {
        this.keys[mapping.axis] = 0;
      }
    }
  }

  private onResize() {
    this.cameraRig.camera.aspect = window.innerWidth / window.innerHeight;
    this.cameraRig.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  updateLivery(livery: Livery) {
    this.shipBuilder.applyLivery(livery);
  }

  async loadWorld(systemId: string, seed: string) {
    await this.worldManager.loadWorld(systemId, seed);
  }

  private lastFrameTime = performance.now();

  private animate = () => {
    frameMonitor.frameStarted();
    requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    // Update ship positions and sync regime
    const states = this.network.getState(Date.now());
    
    // Assume the first entity is the local player for now
    let localPlayer: any = null;
    if (states.length > 0) {
      localPlayer = states[0];
      if (localPlayer.regime !== this.currentRegime) {
        console.debug(`[Renderer] Regime swap: ${this.currentRegime} -> ${localPlayer.regime}`);
        this.currentRegime = localPlayer.regime as FlightRegime;
        
        // Update camera rig mode
        const mode = localPlayer.regime === 'surface' ? 'OnFoot' : 'Cockpit';
        this.cameraRig.setMode(mode);
      }
    }

    // Update camera rig
    this.cameraRig.update(dt, localPlayer, this.worldManager);

    if (localPlayer) {
      const playerPos = new THREE.Vector3(localPlayer.pos.x, localPlayer.pos.y, localPlayer.pos.z);
      const nearest = this.worldManager.getNearestPlanet(playerPos);
      if (nearest) {
        const alt = playerPos.distanceTo(nearest.pos) - nearest.planet.radiusKm * 1000;
        const haze = boundaryFactor(alt, nearest.planet);
        
        const descentSpeed = -localPlayer.vel.y; 
        
        const isReentering = descentSpeed > 200 && haze > 0;
        const tintEl = document.getElementById('reentry-tint');
        if (tintEl) {
          tintEl.style.opacity = isReentering ? '1' : '0';
        }
        
        this.atmosphereDome.update(
          nearest.planet, 
          nearest.pos, 
          playerPos, 
          new THREE.Color(0x000000) // Skybox color placeholder
        );
      } else {
        this.atmosphereDome.getMesh().visible = false;
        const tintEl = document.getElementById('reentry-tint');
        if (tintEl) {
          tintEl.style.opacity = '0';
        }
      }
    }

    // Handle input
    this.network.sendInput({
      thrust: this.keys.thrust ? 1 : 0,
      pitch: this.keys.pitch || 0,
      yaw: this.keys.yaw || 0,
      turn: this.keys.roll || 0,
      up: this.keys.up || 0,
      fire: false,
      lock: false,
    });

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

    this.renderer.render(this.scene, this.cameraRig.camera);
    frameMonitor.frameEnded();
  };
}
