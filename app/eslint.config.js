import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const nodeBuiltins = builtinModules.flatMap((name) => [name, `node:${name}`]);
const nodeGlobals = ['process', 'Buffer', '__dirname', '__filename', 'require', 'global'];
const domGlobals = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'self',
  'crypto',
];

/** Builds a `no-restricted-imports` rule from path names and gitignore-style patterns. */
function restrictImports(paths, patterns, message) {
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: paths.map((name) => ({ name, message })),
        patterns: patterns.map((group) => ({ group: [group], message })),
      },
    ],
  };
}

/** Builds a `no-restricted-globals` rule listing globals with a shared message. */
function restrictGlobals(names, message) {
  return { 'no-restricted-globals': ['error', ...names.map((name) => ({ name, message }))] };
}

/** Relative imports of TS modules must carry their extension (native config loader needs it). */
const relativeImportExtension = {
  selector:
    'ImportDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|tsx|css|json)$/])',
  message: 'Relative imports must include the file extension, e.g. ./config.ts.',
};

/** Math members that are not required to be correctly rounded, so differ between JS engines. */
const engineDependentMath = [
  'random',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'log',
  'log2',
  'log10',
  'log1p',
  'exp',
  'expm1',
  'pow',
  'cbrt',
  'hypot',
];

/** Selectors banned in deterministic generation code on top of the import-extension rule. */
const nondeterministicSyntax = [
  relativeImportExtension,
  {
    selector: "BinaryExpression[operator='**'], AssignmentExpression[operator='**=']",
    message: 'The ** operator can use an engine-dependent pow; multiply explicitly.',
  },
  {
    selector: "NewExpression[callee.name='Date'], CallExpression[callee.object.name='Date']",
    message: 'Date is non-deterministic; generation must be a pure function of its inputs.',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'dist-server', 'node_modules', 'test-results', 'playwright-report', 'data'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', relativeImportExtension],
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  {
    // src/shared runs verbatim in the browser and Node: no client/server code, DOM or Node APIs.
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      ...restrictImports(
        nodeBuiltins,
        ['@client/*', '@server/*', '**/client/**', '**/server/**', 'ws', 'fastify', 'fastify/*'],
        'src/shared must not import from client, server or Node-only modules.',
      ),
      ...restrictGlobals(
        [...nodeGlobals, ...domGlobals],
        'src/shared must not use DOM or Node globals.',
      ),
    },
  },
  {
    // Tests may use Node built-ins (fs, crypto for fixture checksums) but never client/server code.
    files: ['src/shared/**/*.test.ts'],
    rules: restrictImports(
      [],
      ['@client/*', '@server/*', '**/client/**', '**/server/**'],
      'src/shared tests must not import client or server code.',
    ),
  },
  {
    // Cross-engine determinism: only exactly-specified math in the PRNG and galaxy generators.
    files: ['src/shared/random.ts', 'src/shared/galaxy/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...engineDependentMath.map((property) => ({
          object: 'Math',
          property,
          message: `Math.${property} is not guaranteed identical across JS engines.`,
        })),
        { object: 'Date', property: 'now', message: 'Date.now is non-deterministic.' },
        { object: 'crypto', property: 'getRandomValues', message: 'Non-deterministic.' },
        { object: 'crypto', property: 'randomUUID', message: 'Non-deterministic.' },
        { object: 'performance', property: 'now', message: 'Non-deterministic.' },
      ],
      'no-restricted-syntax': ['error', ...nondeterministicSyntax],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    rules: restrictImports(
      nodeBuiltins,
      ['@server/*', '**/server/**'],
      'src/client must not import server code or Node built-ins.',
    ),
  },
  {
    files: ['src/server/**/*.{ts,tsx}'],
    rules: restrictImports(
      [],
      ['@client/*', '**/client/**'],
      'src/server must not import client code.',
    ),
  },
  prettier,
);
