import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = process.cwd();

export default defineConfig({
  root: resolve(root, 'src/ui'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: {
        dashboard: resolve(root, 'src/ui/dashboard.html'),
      },
    },
  },
});
