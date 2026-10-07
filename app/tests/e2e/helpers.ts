import { expect, type Page } from '@playwright/test';

/**
 * Shared e2e utilities (TASK-70): unique callsigns and console-error
 * collection. Per the callsign schema: 3–16 alphanumerics + dashes,
 * lowercased server-side.
 */

/** Unique-per-run callsign (timestamp suffix) — sqlite reuse never collides. */
export function uniqueCallsign(prefix: string): string {
  return `${prefix}${Date.now().toString(36).slice(-8)}`;
}

/** Collect console errors + uncaught page errors; assert clean at the end. */
export function collectErrors(page: Page): { errors: string[]; assertClean: () => void } {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return {
    errors,
    assertClean: () => {
      expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
    },
  };
}

/**
 * Mean luminance of ONE 32x32 region at the exact canvas center (TASK-8):
 * after a warp the target system's star sits at the world origin, which the
 * WorldManager camera centers on — a bright (non-background) mean proves
 * the world swap rendered.
 */
export async function canvasCenterLuminanceMean(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return -1;
    const size = 32;
    // GL's readPixels origin is bottom-left; the DOM center is (w/2, h/2).
    const x = Math.floor(canvas.width / 2) - size / 2;
    const y = Math.floor(canvas.height / 2) - size / 2;
    const buf = new Uint8Array(size * size * 4);
    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    const n = size * size;
    for (let i = 0; i < n; i++) {
      sum += (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
    }
    return sum / n;
  });
}

/**
 * Render smoke: sample several 32x32 regions of #game-canvas via GL
 * readPixels and return the BEST (max) luminance variance. > 0 proves WebGL
 * drew something non-uniform (not a black/flat screen). readPixels reads the
 * drawing buffer, so DOM HUD overlays never interfere. The best-of-4 keeps a
 * starless-region false negative effectively impossible. Callers may pass
 * custom (GL, origin-bottom-left) regions when the interesting content is
 * elsewhere (e.g. the disembark on-foot view's dead-center character).
 */
export async function canvasLuminanceVariance(
  page: Page,
  regions?: Array<[number, number]>,
): Promise<number> {
  return page.evaluate((rs: Array<[number, number]> | undefined) => {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return -1;
    const size = 32;
    const sampleRegions: Array<[number, number]> =
      rs && rs.length > 0
        ? rs
        : [
            [100, 400],
            [500, 200],
            [900, 500],
            [1100, 150],
          ];
    const buf = new Uint8Array(size * size * 4);
    let best = 0;
    for (const [x, y] of sampleRegions) {
      gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0;
      let sumSq = 0;
      const n = size * size;
      for (let i = 0; i < n; i++) {
        const lum = (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
        sum += lum;
        sumSq += lum * lum;
      }
      const mean = sum / n;
      best = Math.max(best, sumSq / n - mean * mean);
    }
    return best;
  }, regions);
}

/**
 * TASK-75: luminance statistics of a DOM-fraction rectangle of the canvas.
 * The region is given in canvas FRACTIONS with the DOM TOP-LEFT origin;
 * returns the mean luminance (0..255) and the COUNT of pixels with
 * luminance > 60 (bright star/sky pixels). This — not
 * canvasLuminanceVariance — is the valid blackout check: in a blacked-out
 * frame the chase-camera ship in the middle of the screen still produces
 * bright pixels, so whole-canvas stats mask the blackout. The blackout
 * assertions sample the TOP band `{ x0: 0, y0: 0, x1: 1, y1: 0.3 }`
 * (above the ship). Returns mean -1 when the canvas/GL context is missing.
 */
export async function canvasRegionStats(
  page: Page,
  region: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ mean: number; bright: number }> {
  return page.evaluate((r) => {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return { mean: -1, bright: 0 };
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { mean: -1, bright: 0 };
    const w = canvas.width;
    const h = canvas.height;
    // GL's readPixels origin is BOTTOM-left; the region is DOM top-left, so
    // the GL y-range is [(1 - y1)h, (1 - y0)h] (flipped).
    const x = Math.floor(r.x0 * w);
    const width = Math.max(1, Math.ceil(r.x1 * w) - x);
    const y = Math.floor((1 - r.y1) * h);
    const height = Math.max(1, Math.ceil((1 - r.y0) * h) - y);
    const buf = new Uint8Array(width * height * 4);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < width * height; i++) {
      const lum = (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
      sum += lum;
      if (lum > 60) bright += 1;
    }
    return { mean: sum / (width * height), bright };
  }, region);
}

/**
 * Brightest luminance (0..255) inside a 32x32 GL region at (x, y) — bottom-
 * left origin. Proves a specific bright object is on screen (the disembark
 * on-foot view's cyan character capsule is dead-center and reads ~190, the
 * dark sky/terrain ~35) where variance alone cannot (a flat-colored object
 * has ZERO internal variance).
 */
export async function canvasMaxLuminance(page: Page, x: number, y: number): Promise<number> {
  const xy: [number, number] = [x, y];
  return page.evaluate((pair: [number, number]) => {
    const [gx, gy] = pair;
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return -1;
    const size = 32;
    const buf = new Uint8Array(size * size * 4);
    gl.readPixels(gx, gy, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let max = 0;
    for (let i = 0; i < size * size; i++) {
      max = Math.max(max, (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3);
    }
    return max;
  }, xy);
}

/**
 * TASK-82: mean luminance of a square `size`×`size` region centred on a
 * CSS-pixel SCREEN position (origin top-left — exactly what
 * WorldManager.projectToScreen reports for the sun). Handles the canvas's
 * device-pixel scaling (GL buffer is in device px) and GL's bottom-left
 * origin (DOM top-left → GL y = h − y). Returns -1 if the region is off-canvas
 * or the canvas/GL context is missing.
 */
export async function canvasScreenRegionMean(
  page: Page,
  x: number,
  y: number,
  size = 8,
): Promise<number> {
  return page.evaluate(
    ({ x, y, size }) => {
      const canvas = document.getElementById('game-canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return -1;
      const gl = (canvas.getContext('webgl2') ??
        canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) return -1;
      // CSS px → device px (the GL drawing buffer is device-pixel sized).
      const sx = canvas.width / (canvas.clientWidth || canvas.width);
      const sy = canvas.height / (canvas.clientHeight || canvas.height);
      const cx = Math.round(x * sx);
      const cy = Math.round(y * sy);
      // GL origin is bottom-left; DOM top-left → flip y about the height.
      const gx = cx - Math.floor(size / 2);
      const gy = canvas.height - cy - Math.floor(size / 2);
      if (gx < 0 || gy < 0 || gx + size > canvas.width || gy + size > canvas.height) return -1;
      const buf = new Uint8Array(size * size * 4);
      gl.readPixels(gx, gy, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0;
      for (let i = 0; i < size * size; i++) {
        sum += (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
      }
      return sum / (size * size);
    },
    { x, y, size },
  );
}
