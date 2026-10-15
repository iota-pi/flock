import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import wasm from 'vite-plugin-wasm'

import { visualizer } from 'rollup-plugin-visualizer'

const isProductionBuild = process.env.NODE_ENV === 'production'
const sentryOrg = process.env.SENTRY_ORG
const sentryProject = process.env.SENTRY_PROJECT
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN

export default defineConfig({
  base: '/',
  plugins: [
    wasm(),
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      injectManifest: {
        rollupFormat: 'es',
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
      },
      // The app decides when a new version takes over (src/app/appUpdate.ts)
      registerType: 'prompt',
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
    isProductionBuild && sentryOrg && sentryProject && sentryAuthToken
      ? sentryVitePlugin({
        org: sentryOrg,
        project: sentryProject,
        authToken: sentryAuthToken,
        sourcemaps: {
          // Avoid exposing sourcemaps publicly on Cloudflare Pages
          filesToDeleteAfterUpload: ['dist/**/*.map'],
        },
      })
      : null,
    visualizer() as any,
  ].filter(Boolean),
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
  },
  optimizeDeps: {
    // Only imported from the sync worker, which the dep scanner doesn't crawl.
    // Without this, discovery on first load triggers a full page reload.
    include: ['@automerge/automerge/slim'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist/app',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.match(/react\/|react-dom\//)) {
              return 'vendor-react'
            }
            if (id.match(/@emotion\/react|@emotion\/styled/)) {
              return 'vendor-emotion'
            }
            if (id.match(/@mui\/lab/)) {
              return 'vendor-mui-lab'
            }
            if (id.match(/@mui\/material|@mui\/system/)) {
              return 'vendor-mui-core'
            }
            if (id.match(/@mui\/icons-material/)) {
              return 'vendor-icons'
            }
            if (id.match(/@mui\/x-date-pickers|date-fns/)) {
              return 'vendor-date-utils'
            }
            if (id.match(/@tanstack\/react-query/)) {
              return 'vendor-utils'
            }
            if (id.match(/zxcvbn/)) {
              return 'vendor-security'
            }
            if (id.match(/lodash-es|zod|@trpc\//)) {
              return 'vendor-utils'
            }
          }
        },
      },
    },
  },
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
    ],
  },
})
