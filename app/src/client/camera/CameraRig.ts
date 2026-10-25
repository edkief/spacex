import * as THREE from 'three';

export type CameraMode = 'Cockpit' | 'OnFoot';

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export class CameraRig {
  public camera: THREE.PerspectiveCamera;
  private mode: CameraMode = 'Cockpit';
  private isHandoff = false;
  private handoffProgress = 0;
  private handoffStartPose: Pose | null = null;
  private handoffDuration = 0.6; // 600ms
  
  private cockpitSmoothingK = 8;
  private currentPose: Pose;
  
  private onFootYaw = 0;
  private onFootPitch = 0;
  private inputLocked = false;

  public setOnFootRotation(yaw: number, pitch: number) {
    this.onFootYaw = yaw;
    const limit = (80 * Math.PI) / 180;
    this.onFootPitch = Math.max(-limit, Math.min(limit, pitch));
  }

  public getOnFootRotation() {
    return { yaw: this.onFootYaw, pitch: this.onFootPitch };
  }

  constructor() {
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.currentPose = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    };

    if (import.meta.env.DEV) {
      (window as any).__cameraRig = this;
    }

    // Mouse look for OnFoot
    window.addEventListener('mousemove', (e) => {
      if (this.mode === 'OnFoot' && !this.inputLocked) {
        const sensitivity = 0.002;
        this.onFootYaw -= e.movementX * sensitivity;
        this.onFootPitch -= e.movementY * sensitivity;
        
        // Clamp pitch -80 to +80 degrees
        const limit = (80 * Math.PI) / 180;
        this.onFootPitch = Math.max(-limit, Math.min(limit, this.onFootPitch));
      }
    });
  }

  public setMode(mode: CameraMode) {
    if (this.mode === mode) return;
    
    this.startHandoff(mode);
    this.mode = mode;
  }

  private startHandoff(newMode: CameraMode) {
    this.isHandoff = true;
    this.handoffProgress = 0;
    this.inputLocked = true;
    
    this.handoffStartPose = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
    };
  }

  public update(dt: number, localPlayer: any, worldManager: any) {
    if (this.isHandoff) {
      this.updateHandoff(dt, localPlayer, worldManager);
      return;
    }

    if (this.mode === 'Cockpit') {
      this.updateCockpit(dt, localPlayer);
    } else {
      this.updateOnFoot(dt, localPlayer);
    }
  }

  private updateCockpit(dt: number, localPlayer: any) {
    if (!localPlayer || localPlayer.kind !== 'ship') return;

    // Cockpit pose = ship.pos + ship.quat * offset(0, 0.5, 1.2)
    const offset = new THREE.Vector3(0, 0.5, 1.2);
    const shipQuat = new THREE.Quaternion(localPlayer.quat.x, localPlayer.quat.y, localPlayer.quat.z, localPlayer.quat.w);
    offset.applyQuaternion(shipQuat);
    
    const targetPos = new THREE.Vector3().copy(localPlayer.pos).add(offset);
    const targetQuat = shipQuat.clone();

    // Smoothing: exponential lerp
    const k = this.cockpitSmoothingK;
    const t = 1 - Math.exp(-k * dt);
    
    this.currentPose.position.lerp(targetPos, t);
    this.currentPose.quaternion.slerp(targetQuat, t);

    this.camera.position.copy(this.currentPose.position);
    this.camera.quaternion.copy(this.currentPose.quaternion);
  }

  private updateOnFoot(dt: number, localPlayer: any) {
    if (!localPlayer || localPlayer.kind !== 'character') return;

    const charPos = new THREE.Vector3(localPlayer.pos.x, localPlayer.pos.y, localPlayer.pos.z);
    const charQuat = new THREE.Quaternion(localPlayer.quat.x, localPlayer.quat.y, localPlayer.quat.z, localPlayer.quat.w);
    
    // Base position: 4m behind, 1.6m up
    const offset = new THREE.Vector3(0, 1.6, -4);
    offset.applyQuaternion(charQuat);
    
    this.camera.position.copy(charPos).add(offset);
    
    // Mouse look: combine character rotation with mouse yaw/pitch
    const lookQuat = new THREE.Quaternion();
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.onFootYaw);
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.onFootPitch);
    
    lookQuat.multiply(yawQuat).multiply(pitchQuat);
    
    // The final rotation is character rotation * mouse rotation
    this.camera.quaternion.copy(charQuat).multiply(lookQuat);
  }

  private updateHandoff(dt: number, localPlayer: any, worldManager: any) {
    this.handoffProgress += dt / this.handoffDuration;
    
    if (this.handoffProgress >= 1) {
      this.isHandoff = false;
      this.inputLocked = false;
      return;
    }

    const t = this.easeInOut(this.handoffProgress);
    const targetPose = this.calculateTargetPose(localPlayer);
    
    if (!this.handoffStartPose) return;

    // Position lerp with collision nudge
    const pos = new THREE.Vector3().lerpVectors(this.handoffStartPose.position, targetPose.position, t);
    
    if (worldManager) {
      const h = worldManager.heightAt(pos.x, pos.z);
      if (pos.y < h) {
        pos.y = h + 0.1;
      }
    }
    
    this.camera.position.copy(pos);
    this.camera.quaternion.slerpQuaternions(this.handoffStartPose.quaternion, targetPose.quaternion, t);
  }

  private calculateTargetPose(localPlayer: any): Pose {
    if (this.mode === 'Cockpit') {
      const offset = new THREE.Vector3(0, 0.5, 1.2);
      const shipQuat = new THREE.Quaternion(localPlayer.quat.x, localPlayer.quat.y, localPlayer.quat.z, localPlayer.quat.w);
      offset.applyQuaternion(shipQuat);
      return {
        position: new THREE.Vector3().copy(localPlayer.pos).add(offset),
        quaternion: shipQuat,
      };
    } else {
      const charPos = new THREE.Vector3(localPlayer.pos.x, localPlayer.pos.y, localPlayer.pos.z);
      const charQuat = new THREE.Quaternion(localPlayer.quat.x, localPlayer.quat.y, localPlayer.quat.z, localPlayer.quat.w);
      const offset = new THREE.Vector3(0, 1.6, -4);
      offset.applyQuaternion(charQuat);
      return {
        position: charPos.add(offset),
        quaternion: charQuat,
      };
    }
  }

  private easeInOut(t: number) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
}
