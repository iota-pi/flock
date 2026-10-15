import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    silent: 'passed-only',
    execArgv: ['--no-webstorage'],
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
