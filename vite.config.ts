import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import browserslistToEsbuild from 'browserslist-to-esbuild';

import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  base: '',
  plugins: [react(), viteTsconfigPaths(), visualizer()],
  server: {
    open: true,
    port: 3000,
  },
  build: {
    target: browserslistToEsbuild(),
    outDir: 'dist/app',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.match(/@mui\/icons-material|react-icons/)) {
              return 'vendor-icons'
            }
            if (id.match(/firebase\/(app|messaging)/)) {
              return 'vendor-firebase'
            }
            if (id.match(/@mui\/x-date-pickers|date-fns/)) {
              return 'vendor-date-utils'
            }
            if (id.match(/@tanstack\/react-query|axios|redux|@reduxjs\/toolkit/)) {
              return 'vendor-utils'
            }
            if (id.match(/zxcvbn/)) {
              return 'vendor-security'
            }
          }
        },
      },
    },
  },
});
