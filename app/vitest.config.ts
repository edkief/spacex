import { defineConfig } from 'vitest/config';

// Two projects share one config. `node` runs every test except `*.dom.test.*`. `dom` (jsdom) runs
// `*.dom.test.*` and `*.parity.test.*`; parity files also run under `node`, so a test that must
// behave identically in Node and a browser-like environment just needs the `.parity.test.ts`
// suffix. Run one environment with `vitest run --project node|dom`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.dom.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.{ts,tsx}', 'src/**/*.parity.test.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
});
