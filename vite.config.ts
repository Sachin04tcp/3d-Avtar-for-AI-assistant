import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    // three.js + its example loaders are large; silence the chunk warning for this test app
    chunkSizeWarningLimit: 1500,
  },
});
