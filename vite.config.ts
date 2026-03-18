import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import browserslistToEsbuild from 'browserslist-to-esbuild';
import { VitePWA } from 'vite-plugin-pwa';

import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  base: '',
  plugins: [
    react(),
    viteTsconfigPaths(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      registerType: 'autoUpdate',
      manifest: {
        short_name: 'Flock',
        name: 'Flock',
        icons: [
          {
            src: '/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
        start_url: '.',
        display: 'standalone',
        theme_color: '#004d40',
        background_color: '#202020',
      },
    }),
    visualizer() as any,
  ],
  server: {
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
            if (id.match(/@mui\/icons-material/)) {
              return 'vendor-icons'
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
