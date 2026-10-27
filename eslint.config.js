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

// Flock's migration app, which holds the compatibility code for legacy formats (see "Backwards
// compatibility" in docs/vault-extraction.md). The main app may only use its detection module.
const MIGRATE_PATH = 'src/migrate'

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
  {
    target: './packages/vault-client/src/api',
    from: ['./packages/vault-client/src/sync/client', './packages/vault-client/src/sync/worker'],
    message: 'The sync engine builds on api/, not the reverse. Move what both need to sync/utils or sync/shared.',
  },
  {
    target: './packages/vault-client/src/sync/worker',
    from: './packages/vault-client/src/sync/client',
    message: 'The sync worker must not import main-thread code. Move what both need to sync/utils or sync/shared.',
  },
]

const vaultPackageImportPatterns = [
  { regex: '^vitest$', allowTypeImports: true },
  { regex: '^src/', message: 'Vault library code must not import Flock app code.' },
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
          "paths": [
            { "name": "react", "importNames": ["lazy"], "message": "Use `lazy` from 'src/utils/lazy' so tests can wait for lazy loads." },
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
      'no-restricted-imports': ['error', { patterns: vaultPackageImportPatterns }],
    },
  },
  {
    files: ['packages/vault-client/src/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/__test__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...vaultPackageImportPatterns,
            {
              regex: '^@vault/server$',
              allowTypeImports: true,
              message: '@vault/client may only import types from @vault/server (it is a type-only peer dependency).',
            },
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
    ignores: [`${MIGRATE_PATH}/**`],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src',
              from: `./${MIGRATE_PATH}`,
              except: ['./detection.ts'],
              message: 'The main app may only import the migration app detection module (see docs/vault-extraction.md).',
            },
          ],
        },
      ],
    },
  },
  {
    files: [`${MIGRATE_PATH}/detection.ts`],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: `./${MIGRATE_PATH}/detection.ts`,
              from: `./${MIGRATE_PATH}/legacy`,
              message: 'The main app imports detection.ts, so it must not pull in legacy code.',
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
      '**/test/**/*.ts',
      '**/testUtils.ts',
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
      // Test files share module state (`isolate: false`), so a module mock would leak into
      // whichever files run after it in the same worker
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/]",
          message: 'Test files share module state, so vi.mock leaks between them. Use vi.spyOn on the module namespace '
            + '(or spyOnExports) in beforeEach, or for a package, its mutable copy in the setup file.',
        },
      ],
    },
  },
  {
    // Setup files mock each package that specs spy on once, with a mutable copy that every file shares
    files: ['packages/*/test/setup.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
])
