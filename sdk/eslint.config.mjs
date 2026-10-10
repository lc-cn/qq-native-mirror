import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['.local/**', 'dist/**', 'node_modules/**', 'native/**', 'docs/evidence/**'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.{ts,mjs}', 'scripts/**/*.{ts,mjs}', '*.mjs'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
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
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    // Invalid-input fixtures intentionally cross the native seam with synthetic values.
    files: ['test/**/*.{ts,mjs}', 'scripts/**/*.{ts,mjs}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
]);
