import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** Generated output, vendored dependencies and local runtime state. */
const ignoredPaths = [
  '**/node_modules/**',
  '**/.next/**',
  '**/out/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/.firebase/**',
  '**/.turbo/**',
  '**/emulator-data/**',
  '**/next-env.d.ts',
];

/** Test and end-to-end files, where deliberately malformed input is the point. */
const relaxedFiles = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**/*.ts'];

/**
 * Build the repository's flat ESLint configuration.
 *
 * There is a single lint entry point at the repository root, so the TypeScript
 * project service is anchored there rather than inside this package. Pass the
 * absolute path of the repository root as `tsconfigRootDir`.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function createEslintConfig({ tsconfigRootDir }) {
  return tseslint.config(
    { ignores: ignoredPaths },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        // The TypeScript compiler resolves identifiers and knows about ambient
        // globals; `no-undef` only reports false positives in this repository.
        'no-undef': 'off',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        // Several adapters implement an asynchronous port with intentionally
        // synchronous internals (memory, fixtures). The contract is the
        // promise, not the await, so this rule only adds noise.
        '@typescript-eslint/require-await': 'off',
      },
    },
    {
      // Plain JavaScript configuration files belong to no TypeScript project,
      // so they are parsed without type information rather than excluded.
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: {
        parserOptions: { projectService: false, project: false, program: null },
      },
    },
    {
      files: relaxedFiles,
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
      },
    },
    eslintConfigPrettier,
  );
}
