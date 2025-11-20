import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: [
        'src/setupTests.ts',
        'src/vitest.config.ts',
        'src/env.ts',
        'src/main.tsx',
        'src/index.html',
        'src/icons/**',
        'src/utils/testUtils.ts',
      ],
    },
  },
})
