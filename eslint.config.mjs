/**
 * ESLint flat config (ESLint v9+).
 *
 * Minimal TypeScript ruleset focused on correctness over style. Style
 * is handled by Prettier separately. Tests have looser rules around
 * `any` and unused variables since `vi.fn()` mocks regularly need them.
 */
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '.vscode-test/**',
      'test-reports/**',
      'webview-ui/dist/**',
      '*.vsix',
      'eslint.config.mjs',
      'esbuild.mjs',
      'vitest.config.ts',
      'vitest.integration.config.ts',
      'scripts/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Correctness rules — these catch real bugs.
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-self-compare': 'error',
      'no-unreachable-loop': 'error',
      'no-unused-private-class-members': 'warn',
      'prefer-const': 'warn',

      // TypeScript-specific.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Tests are looser on style — focus on correctness only.
      'no-debugger': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
