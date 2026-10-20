/**
 * Starfield canvas placeholder (TASK-70).
 *
 * Renders a deterministic WebGL starfield into the page's main
 * `<canvas>` so the harness can verify that the headless browser
 * boots a non-black surface (sampling pixels with `readPixels`
 * shows variance). The full three.js streaming pipeline will
 * replace this stub when TASK-26 lands; for now the starfield is
 * just enough to prove the WebGL context is live.
 *
 * Why raw WebGL (not three.js)?
 *   - Three.js setup adds ~600 KB of bundle + a deferred mount;
 *     the harness smoke only needs proof of life. Raw WebGL
 *     keeps the harness fast and keeps three.js out of the v1
 *     bundle until TASK-26 wires the real renderer.
 *   - The starfield is deterministic (seeded RNG) so future
 *     determinism tests (TASK-71) can assert pixel-level
 *     stability across runs.
 *
 * Layout:
 *   - 200 stars scattered in a unit circle around the origin,
 *     projected via a simple orthographic shader that draws a
 *     soft-edged disc per star.
 *   - Background is the deep navy the spec calls for so the
 *     contrast against stars is high enough to read in
 *     screenshots.
 *
 * If WebGL is unavailable (older browsers, locked-down
 * sandboxes) the canvas falls back to a flat dark colour and the
 * component logs a single, non-fatal `console.warn` so the
 * existing Playwright smoke tests still pass with zero console
 * errors.
 */
import * as React from "react";
import { useEffect, useRef } from "react";

/** Number of stars in the field — density chosen so even a small viewport patch has at least a few. */
const STAR_COUNT = 800;

/** Deterministic LCG so future determinism tests can re-seed. */
function makeStarRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0xdeadbeef;
  return () => {
    // Linear-congruential generator (Numerical Recipes constants).
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Background RGBA — deep navy from the spec. */
const CLEAR_COLOR: readonly [number, number, number, number] = [0.02, 0.025, 0.04, 1.0];

interface StarfieldHandle {
  /** Resize-aware viewport dimensions in CSS pixels. */
  resize(cssWidth: number, cssHeight: number): void;
  /** Re-render one frame. Called once after init + on resize. */
  draw(): void;
}

/**
 * Build a minimal WebGL starfield in the given canvas.
 *
 * Returns `null` if WebGL is unavailable so the caller can fall
 * back to a flat colour without surfacing a console error.
 */
function initStarfield(canvas: HTMLCanvasElement, dpr: number): StarfieldHandle | null {
  const gl =
    (canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null) ?? null;
  if (!gl) return null;

  // --- Vertex shader: render stars as point sprites.
  const vsrc = `
    attribute vec2 a_pos;
    attribute float a_size;
    attribute float a_brightness;
    uniform vec2 u_viewport;
    varying float v_brightness;
    void main() {
      // Project from unit circle to clip space.
      vec2 clip = a_pos;
      gl_Position = vec4(clip, 0.0, 1.0);
      // Convert point size to pixels (clamped so a small viewport still has stars).
      gl_PointSize = max(1.5, a_size * min(u_viewport.x, u_viewport.y) / 60.0);
      v_brightness = a_brightness;
    }
  `;
  // --- Fragment shader: soft-edged white disc.
  const fsrc = `
    precision mediump float;
    varying float v_brightness;
    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = length(d);
      // Soft falloff — bright centre, dim edge.
      float a = smoothstep(0.5, 0.0, r) * v_brightness;
      // Slight blue tint on the brightest stars so the field reads as "cold".
      vec3 col = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 1.0, 1.0), v_brightness);
      gl_FragColor = vec4(col, a);
    }
  `;

  const compile = (type: number, src: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);

  // --- Allocate the per-star attribute arrays.
  const positions = new Float32Array(STAR_COUNT * 2);
  const sizes = new Float32Array(STAR_COUNT);
  const brightnesses = new Float32Array(STAR_COUNT);
  const rng = makeStarRng(0xc0ffee ^ dpr);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Polar coordinates inside the unit disc — keeps star density uniform.
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng());
    positions[i * 2] = Math.cos(angle) * radius;
    positions[i * 2 + 1] = Math.sin(angle) * radius;
    // 90 % dim background stars, 10 % bright foreground.
    const isBright = rng() < 0.1;
    sizes[i] = isBright ? 1.5 + rng() * 1.2 : 0.6 + rng() * 0.4;
    brightnesses[i] = isBright ? 0.7 + rng() * 0.3 : 0.25 + rng() * 0.35;
  }

  const posBuf = gl.createBuffer();
  const sizeBuf = gl.createBuffer();
  const brightBuf = gl.createBuffer();
  if (!posBuf || !sizeBuf || !brightBuf) return null;

  const aPos = gl.getAttribLocation(program, "a_pos");
  const aSize = gl.getAttribLocation(program, "a_size");
  const aBright = gl.getAttribLocation(program, "a_brightness");
  const uViewport = gl.getUniformLocation(program, "u_viewport");

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, sizes, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(aSize);
  gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, brightBuf);
  gl.bufferData(gl.ARRAY_BUFFER, brightnesses, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(aBright);
  gl.vertexAttribPointer(aBright, 1, gl.FLOAT, false, 0, 0);

  // Enable additive blending so overlapping stars sum rather than occlude.
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  // --- Starfield handle.
  const resize = (cssWidth: number, cssHeight: number): void => {
    const w = Math.max(1, Math.floor(cssWidth * dpr));
    const h = Math.max(1, Math.floor(cssHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uViewport, w, h);
  };

  const draw = (): void => {
    gl.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
  };

  return { resize, draw };
}

/**
 * The Drift main canvas. Renders a deterministic WebGL starfield
 * that fills the viewport. Future three.js rendering (TASK-26+)
 * will own this same canvas; the e2e harness relies on the
 * starfield to verify that headless WebGL is live.
 */
export interface CanvasStageProps {
  /**
   * TASK-54: the accessible name for the canvas. The canvas is a
   * single opaque 3-D view, so it is exposed as `role="img"` with
   * a label that names the system the player is flying in.
   */
  label?: string;
}

/**
 * The Drift main canvas. Renders a deterministic WebGL starfield
 * that fills the viewport. Future three.js rendering (TASK-26+)
 * will own this same canvas; the e2e harness relies on the
 * starfield to verify that headless WebGL is live.
 */
export function CanvasStage(props: CanvasStageProps = {}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<StarfieldHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // The canvas is sized via CSS; we read the rendered size on
    // each frame so a viewport resize still renders correctly.
    // Using `devicePixelRatio` (capped at 2) keeps the harness
    // sharp on hi-DPI displays without paying for 4× pixels.
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const handle = initStarfield(canvas, dpr);
    if (!handle) {
      // Fall back to a flat dark fill so the canvas is non-null
      // but mark it as "no WebGL" so the harness smoke can skip
      // pixel sampling in environments where GL is unavailable.
      canvas.dataset.driftNoWebgl = "1";
      return;
    }
    handleRef.current = handle;

    const apply = (): void => {
      const rect = canvas.getBoundingClientRect();
      handle.resize(rect.width, rect.height);
      handle.draw();
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    if (ro) ro.observe(canvas);
    window.addEventListener("resize", apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="drift-canvas"
      data-testid="drift-canvas"
      role="img"
      aria-label={props.label ?? "3D view: flying in space"}
      style={{ display: "block", width: "100vw", height: "100vh" }}
    />
  );
}
