/**
 * Type declarations for Vite-injected `import.meta.env` properties.
 *
 * The Drift client uses `import.meta.env.DEV` as a build-time
 * constant — Vite replaces it with `true` in dev and `false` in
 * production, so the surrounding `if (!import.meta.env.DEV) return
 * null;` bodies tree-shake out of the production bundle.
 *
 * See https://vitejs.dev/guide/env.html and
 * https://vitejs.dev/guide/migration.html#general-tips for the
 * background on this ambient declaration.
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
