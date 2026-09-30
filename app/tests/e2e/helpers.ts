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
 * starless-region false negative effectively impossible.
 */
export async function canvasLuminanceVariance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.getElementById('game-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return -1;
    const size = 32;
    const regions: Array<[number, number]> = [
      [100, 400],
      [500, 200],
      [900, 500],
      [1100, 150],
    ];
    const buf = new Uint8Array(size * size * 4);
    let best = 0;
    for (const [x, y] of regions) {
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
  });
}
