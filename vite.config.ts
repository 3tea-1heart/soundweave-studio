import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
});
