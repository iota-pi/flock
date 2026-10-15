import { defineConfig, globalIgnores } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import-x'
import stylistic from '@stylistic/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import vitest from '@vitest/eslint-plugin'
import react from 'eslint-plugin-react'
import jsxA11y from 'eslint-plugin-jsx-a11y'

// The vault library's packages (see docs/vault-extraction.md)
const VAULT_PACKAGES = ['vault-shared', 'vault-client', 'vault-server']

// Flock's compatibility code for legacy formats, extracted into the migration app later (see
// docs/vault-extraction.md). Only these wiring files may import it.
const LEGACY_PATH = 'app/vault/legacy'
const LEGACY_IMPORTERS = [
  'app/vault/setup.ts',
  'app/vault/session.ts',
  'app/vault/syncDomain.ts',
  'app/vault/vault.worker.ts',
]

const vaultPackageZones = [
  {
    target: './packages',
    from: './src',
    message: 'Vault library code must not import Flock app code. Inject it instead (see docs/vault-extraction.md).',
  },
  {
    target: './packages/vault-shared',
    from: ['./packages/vault-client', './packages/vault-server'],
    message: '@vault/shared must not depend on the client or server.',
  },
  {
    target: './packages/vault-server',
    from: './packages/vault-client',
    message: '@vault/server must not depend on the client.',
  },
]

export default defineConfig([
  globalIgnores([
    'node_modules',
    'build',
    'dist',
    'coverage',
    'eslint.config.js',
    'src/setupTests.ts',
    'src/sst-env.d.ts',
    'src/types/react.d.ts',
    'src/vault/types.d.ts',
    'sst-env.d.ts',
  ]),
  eslint.configs.recommended,
  tseslint.configs.eslintRecommended,
  tseslint.configs.recommended,
  importPlugin.flatConfigs.errors,
  importPlugin.flatConfigs.warnings,
  importPlugin.flatConfigs.typescript,
  {
    plugins: {
      '@stylistic': stylistic,
      'react-hooks': reactHooks,
      react,
      vitest,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...vitest.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'arrow-parens': ['error', 'as-needed'],
      'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1 }],
      'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
      'import-x/no-rename-default': 'off',
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/indent': ['error', 2],
      "no-restricted-imports": [
        "error",
        {
          "patterns": [
            { "regex": "^@mui/[^/]+$" },
            { "regex": "^vitest$", allowTypeImports: true },
            { "regex": "docstore/core$", allowTypeImports: true, message: "Import from 'docstore/core' is restricted (functions are internal to docstore module)" },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        ecmaVersion: 'latest',
      },
    },
    rules: {
      '@typescript-eslint/no-use-before-define': ['error', { functions: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_$',
          caughtErrorsIgnorePattern: '^_$',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/dot-notation': 'error',
    },
  },
  {
    files: ['packages/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': ['error', { zones: vaultPackageZones }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^vitest$', allowTypeImports: true },
            { regex: '^src/', message: 'Vault library code must not import Flock app code.' },
          ],
        },
      ],
    },
  },
  ...VAULT_PACKAGES.map(name => ({
    files: [`packages/${name}/**/*.ts`],
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { packageDir: `./packages/${name}` }],
    },
  })),
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [`src/${LEGACY_PATH}/**`, ...LEGACY_IMPORTERS.map(path => `src/${path}`)],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src',
              from: `./src/${LEGACY_PATH}`,
              message: "Only Flock's vault wiring may import legacy compatibility code (see docs/vault-extraction.md).",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/tests/**/*.ts',
      '**/tests/**/*.tsx',
      '**/__test__/**/*.ts',
      '**/__test__/**/*.tsx',
      '**/__tests__/**/*.ts',
      '**/__tests__/**/*.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/dot-notation': 'off',
      'vitest/expect-expect': [
        'error',
        {
          assertFunctionNames: ['expect', 'checkA11y'],
        },
      ],
    },
  },
])
