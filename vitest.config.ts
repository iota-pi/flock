import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    silent: 'passed-only',
    execArgv: ['--no-webstorage'],
    pool: 'threads',
    // Files share module state within a worker, so every test must undo its spies and stubs.
    // Module mocks go through `vi.spyOn` or the setup files, never `vi.mock` (lint enforces this).
    isolate: false,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: [
        'src/setupTests.ts',
        'packages/*/test/**',
        'vitest.config.ts',
        'src/env.ts',
        'src/main.tsx',
        'src/index.html',
        'src/icons/**',
        'src/utils/testUtils.ts',
      ],
    },
    alias: {
      'src': '/src',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          environment: 'happy-dom',
          setupFiles: ['./src/setupTests.ts'],
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/vault/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'vault',
          environment: 'node',
          setupFiles: ['./src/setupTests.ts'],
          include: ['src/vault/**/*.{test,spec}.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'vault-shared',
          environment: 'node',
          include: ['packages/vault-shared/src/**/*.{test,spec}.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'vault-client',
          environment: 'happy-dom',
          setupFiles: ['./packages/vault-client/test/setup.ts'],
          include: ['packages/vault-client/src/**/*.{test,spec}.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'vault-server',
          environment: 'node',
          setupFiles: ['./packages/vault-server/test/setup.ts'],
          include: ['packages/vault-server/src/**/*.{test,spec}.ts'],
        },
      },
    ],
  },
})
