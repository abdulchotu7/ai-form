import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Content script: single IIFE file, no code splitting.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'src/content/index.ts'),
      name: 'AFFormContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
