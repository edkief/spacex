import { expect, test, type Page } from '@playwright/test';

interface DriftDebug {
  framesRendered: number;
  shipMeshCount: number;
  planetCount: number;
  inputsSent: number;
  ownShip(): { vel: { x: number; y: number; z: number } } | undefined;
}

/** Reads the dev-only debug hook as plain numbers. */
const drift = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as { __DRIFT__: DriftDebug }).__DRIFT__;
    const vel = d.ownShip()?.vel ?? { x: 0, y: 0, z: 0 };
    return {
      frames: d.framesRendered,
      meshes: d.shipMeshCount,
      planets: d.planetCount,
      inputs: d.inputsSent,
      speed: Math.hypot(vel.x, vel.y, vel.z),
    };
  });

/** Fraction of sampled canvas pixels that differ from the first one (0 = blank frame). */
async function canvasVariety(page: Page): Promise<number> {
  const png = await page.locator('#drift-canvas').screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let different = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      total += 1;
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) different += 1;
    }
    return different / total;
  }, png.toString('base64'));
}

test('a new pilot claims a callsign, sees the system rendered, undocks and flies', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto('/');
  const callsign = `FLY-${Date.now().toString(36).toUpperCase()}`;
  await page.getByLabel('Choose your callsign').fill(callsign);
  await page.getByRole('button', { name: 'Launch' }).click();

  await expect(page.getByTestId('hud-status')).toHaveAttribute('data-status', 'online');
  await expect(page.getByTestId('hud-callsign')).toHaveText(callsign);
  await expect(page.getByTestId('hud-mooring')).toContainText('DOCKED');

  // The renderer is alive: frames advance, the own ship has a mesh, the frame is not blank.
  const before = (await drift(page)).frames;
  await expect.poll(async () => (await drift(page)).meshes).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await drift(page)).frames).toBeGreaterThan(before + 5);
  expect((await drift(page)).planets).toBeGreaterThanOrEqual(2);
  expect(await canvasVariety(page)).toBeGreaterThan(0.001);
  await page.screenshot({ path: '../.ralph/screenshots/TASK-72-docked.png' });

  // Keyboard -> input messages -> server sim -> snapshots: undock, then thrust.
  await page.keyboard.press('KeyU');
  await expect(page.getByTestId('hud-mooring')).toHaveCount(0);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await drift(page)).speed).toBeGreaterThan(50);
  await page.keyboard.up('KeyW');
  expect((await drift(page)).inputs).toBeGreaterThan(10);
  await expect(page.getByTestId('hud-speed')).not.toHaveText('0 m/s');
  await page.screenshot({ path: '../.ralph/screenshots/TASK-73-flying.png' });

  // A reload resumes the stored session without asking for a callsign again.
  await page.reload();
  await expect(page.getByTestId('hud-callsign')).toHaveText(callsign);
  await expect(page.getByTestId('callsign-form')).toHaveCount(0);
  expect(problems).toEqual([]);
});
