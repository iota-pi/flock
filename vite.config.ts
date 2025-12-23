import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import browserslistToEsbuild from 'browserslist-to-esbuild';

export default defineConfig({
  base: '',
  plugins: [react(), viteTsconfigPaths()],
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
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-mui': ['@mui/material', '@mui/icons-material', '@mui/lab'],
          'vendor-firebase': ['firebase/app', 'firebase/messaging'],
          'vendor-utils': ['@mui/x-date-pickers', '@tanstack/react-query', 'axios', 'redux', '@reduxjs/toolkit', 'date-fns'],
          'vendor-security': ['zxcvbn'],
        },
      },
    },
  },
});
