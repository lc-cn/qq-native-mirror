import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Build tools share the SDK's pinned development dependencies; consumers receive none.
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const tseslint = require('typescript-eslint');

export default [
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...js.configs.recommended.rules,
      ...prettier.rules,
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: [
      'ci/verify-consumer.mjs',
      'ci/current-source-mirror.mjs',
      'ci/consumer-resources.mjs',
      'ci/consumer-resources.test.mjs',
      'ci/consumer-acquisition.test.mjs',
      'version-ci/consumer.mjs',
      'version-ci/verify.mjs',
      'version-ci/mirror-selection.mjs',
      'version-ci/matrix.mjs',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tools/tsconfig.consumer-ci.json',
        tsconfigRootDir: fileURLToPath(new URL('../', import.meta.url)),
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-misused-spread': 'error',
    },
  },
];
