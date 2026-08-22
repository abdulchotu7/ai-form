import { defineConfig } from 'vitest/config';

/** Live-API test config: includes *.live.test.ts (excluded from the default run). */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['**/*.live.test.ts'],
  },
});
