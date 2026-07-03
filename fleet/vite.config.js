import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the host Express app under /update/ (production) and proxied to the
// Node API during local dev.
export default defineConfig({
  plugins: [react()],
  base: '/update/',
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'build',
  },
});
