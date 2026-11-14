import * as THREE from 'three';

export interface RenderHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Frames drawn so far. */
  readonly framesRendered: number;
  /** Starts the frame loop; `onFrame` runs before each draw with the frame time in ms. */
  start(onFrame: (now: number, dtMs: number) => void): void;
  stop(): void;
  dispose(): void;
}

/**
 * Owns the WebGL renderer on the game canvas, the scene, the camera and the single
 * requestAnimationFrame loop. A logarithmic depth buffer lets a 20 m ship and a 600 km planet
 * share one view; the camera stays at the origin (see relative.ts).
 */
export function createRenderHost(canvas: HTMLCanvasElement, view: Window = window): RenderHost {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(view.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02030a);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 1e11);

  const resize = (): void => {
    const width = canvas.clientWidth || view.innerWidth;
    const height = canvas.clientHeight || view.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  resize();
  view.addEventListener('resize', resize);

  let frames = 0;
  let handle: number | undefined;
  let last: number | undefined;

  return {
    renderer,
    scene,
    camera,
    get framesRendered() {
      return frames;
    },
    start(onFrame) {
      if (handle !== undefined) return;
      const loop = (now: number): void => {
        onFrame(now, last === undefined ? 0 : now - last);
        last = now;
        renderer.render(scene, camera);
        frames += 1;
        handle = view.requestAnimationFrame(loop);
      };
      handle = view.requestAnimationFrame(loop);
    },
    stop() {
      if (handle !== undefined) view.cancelAnimationFrame(handle);
      handle = undefined;
      last = undefined;
    },
    dispose() {
      this.stop();
      view.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}
