import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiOrigin = process.env.WAKER_API_ORIGIN ?? 'http://127.0.0.1:4410';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@phosphor-icons')) return 'icons';
          if (
            id.includes('react-markdown') ||
            id.includes('remark-gfm') ||
            id.includes('micromark') ||
            id.includes('mdast') ||
            id.includes('unified')
          )
            return 'markdown';
        },
      },
    },
  },
  server: {
    port: 5210,
    proxy: {
      '/api': apiOrigin,
    },
  },
});
