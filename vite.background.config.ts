import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Background service worker: single IIFE file.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'src/background/index.ts'),
      name: 'AFFormBackground',
      formats: ['iife'],
      fileName: () => 'background.js',
    },
  },
});
