// Minimal smoke screenshot for TASK-1 (sandbox setup verification).
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
await page.screenshot({ path: path.resolve(here, '../.ralph/screenshots/TASK-1-1.png') });
console.log('TITLE:', await page.title());
console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
await browser.close();
