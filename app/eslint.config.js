// @ts-check
/**
 * ESLint flat config for the Drift workspace.
 *
 * Uses `typescript-eslint`'s recommended-type-checked ruleset plus Prettier
 * integration so `eslint . && prettier --check .` runs as a single command
 * (`npm run lint`) without double-reporting formatting issues.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "data/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      ".ralph/**",
      "**/*.d.ts",
      // TASK-1 prereqs file uses non-type-only imports intentionally for the
      // runtime fs/url smoke checks; it's not part of the new scaffold.
      "prereqs.test.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Browser (client) globals
        window: "readonly",
        document: "readonly",
        console: "readonly",
        // Node (server) globals are exposed via the `node` global
        // environment below; `process` is provided by @types/node.
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "prereqs.test.ts"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        vi: "readonly",
      },
    },
  },
  prettier,
);
