import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: [
        'src/setupTests.ts',
        'vitest.config.ts',
        'src/env.ts',
        'src/main.tsx',
        'src/index.html',
        'src/icons/**',
        'src/utils/testUtils.ts',
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          environment: 'happy-dom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/vault/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'vault',
          environment: 'node',
          include: ['src/vault/**/*.{test,spec}.ts'],
        },
      },
    ],
  },
})
