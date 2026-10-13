import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5175, strictPort: false },
  preview: { port: 4175, strictPort: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
