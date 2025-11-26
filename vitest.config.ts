import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    // Use node environment for vault tests
    environmentMatchGlobs: [
      ['src/vault/**', 'node'],
    ],
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
  },
})
