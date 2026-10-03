import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    // tests/ holds Playwright e2e specs; validation-fuzz (TASK-64) and
    // session-log-leak (TASK-66) are the node specs living there — named
    // explicitly so scaffold.spec.ts is skipped. tests/abuse/ (TASK-67) is
    // the node cheat-suite: scripted-client scenarios, the economy property
    // test and the schema/limiter audits.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/validation-fuzz.spec.ts',
      'tests/session-log-leak.spec.ts',
      'tests/abuse/*.spec.ts',
    ],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@client': path.resolve(__dirname, 'src/client'),
      '@server': path.resolve(__dirname, 'src/server'),
    },
  },
});
