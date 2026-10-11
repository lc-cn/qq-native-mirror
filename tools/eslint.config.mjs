import { createRequire } from 'node:module';

// Build tools share the SDK's pinned development dependencies; consumers receive none.
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

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
];
