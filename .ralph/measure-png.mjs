// TASK-76.1 throwaway tool (keep until the task closes): measure a screenshot PNG.
// Loads the PNG in a headless chromium page (no pngjs in the repo),
// copies it to a 2d canvas, and reports:
//  - image size
//  - TOP_BAND (x .35-.65, y 0-.3, DOM top-left origin) + FULL_TOP_BAND means —
//    the exact canvasRegionStats computation (mean 0..255, bright = lum > 60)
//  - per-row mean for x .35-.65 across the top 40% (the dark/bright profile)
//  - center-column dark/bright transitions (dark = lum < 35)
// Reference values measured 2026-10-07 (pre-fix dark-disk frame on disk):
//   topBand mean 33.2 (rows 0-.1 visible dome #2b4259 lum 66, rows .15+ disk lum ~11)
//   post-fix (dade5dd) uniform dome haze #314b65 lum ~75
// Usage: cd app && node ../.ralph/measure-png.mjs ../.ralph/screenshots/TASK-76-1.png
import { chromium } from '/workspace/master/app/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: measure-png.mjs <png>');
const b64 = readFileSync(file).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
const data = await page.evaluate(async (b64) => {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = 'data:image/png;base64,' + b64;
  });
  const W = img.width;
  const H = img.height;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const lum = (x, y) => {
    const i = (y * W + x) * 4;
    return (px[i] + px[i + 1] + px[i + 2]) / 3;
  };
  // Region mean in DOM top-left fractions — same math as canvasRegionStats.
  const band = (x0, y0, x1, y1) => {
    let sum = 0;
    let n = 0;
    let bright = 0;
    for (let y = Math.floor(y0 * H); y < Math.ceil(y1 * H); y++) {
      for (let x = Math.floor(x0 * W); x < Math.ceil(x1 * W); x++) {
        const l = lum(x, y);
        sum += l;
        n++;
        if (l > 60) bright++;
      }
    }
    return { mean: +(sum / n).toFixed(1), bright, n };
  };
  const topBand = band(0.35, 0, 0.65, 0.3);
  const fullBand = band(0, 0, 1, 0.3);
  // Per-row mean across x .35-.65, rows 0..0.4H, reported every 4 rows.
  const rows = [];
  for (let y = 0; y < 0.4 * H; y += 4) {
    let s = 0;
    let n = 0;
    for (let x = Math.floor(0.35 * W); x < Math.ceil(0.65 * W); x++) {
      s += lum(x, y);
      n++;
    }
    rows.push({ y, frac: +(y / H).toFixed(3), mean: +(s / n).toFixed(1) });
  }
  // Center-column transitions (dark<35 <-> bright>=35).
  const cx = Math.floor(W / 2);
  const trans = [];
  let prev = lum(cx, 0) < 35;
  for (let y = 1; y < H; y++) {
    const dark = lum(cx, y) < 35;
    if (dark !== prev) {
      trans.push({ y, to: dark ? 'dark' : 'bright', frac: +(y / H).toFixed(3) });
      prev = dark;
    }
  }
  return { W, H, topBand, fullBand, rows, trans };
}, b64);
await browser.close();
console.log(JSON.stringify(data, null, 1));
