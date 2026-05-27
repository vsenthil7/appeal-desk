/**
 * ESLint configuration.
 *
 * The `lint` script (`eslint "src/**\/*.{ts,tsx}"`) previously errored with
 * "ESLint couldn't find a configuration file" because no config existed in the
 * repo. This is the minimal-but-real config that backs that script: the
 * TypeScript parser plus the `@typescript-eslint` recommended set, scoped to
 * `src/`. A few rules are relaxed deliberately so the existing, type-checked
 * codebase lints clean rather than being buried in stylistic noise — the intent
 * is "the advertised command works," not "rewrite working code."
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    'bench/',
    '*.config.ts',
    '*.config.js',
  ],
  rules: {
    // Allow intentionally-unused args when prefixed with `_` (used throughout
    // the Devvit shell handlers, e.g. `onRun(_event, context)`).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // The codebase uses a handful of well-justified casts (e.g. JSON.parse
    // boundaries). These are reviewed at the call site, not banned wholesale.
    '@typescript-eslint/no-explicit-any': 'off',
    // `catch {}` blocks that deliberately swallow non-fatal failures are a
    // documented pattern here (snapshot reads, modmail sends); empty blocks are
    // allowed for catch specifically.
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      // The Devvit shell (.tsx) is type-checked only; keep linting light there.
      // `jsxFactory: "Devvit.createElement"` (see tsconfig.json) means every JSX
      // file must import `Devvit` at runtime even though it is never referenced
      // by name — so the import is NOT an unused variable. `no-unused-vars` can't
      // see the implicit pragma use, so we exempt the pragma identifier here.
      files: ['**/*.tsx'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^(_|Devvit$)',
          },
        ],
      },
    },
    {
      // The sanitiser strips ASCII control characters by design; the control
      // chars in its regex are intentional, not a mistake. (The code review
      // calls this out as correct behaviour.)
      files: ['**/validation/**/*.ts'],
      rules: {
        'no-control-regex': 'off',
      },
    },
  ],
};
