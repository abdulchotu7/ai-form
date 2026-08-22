import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // Live-API tests (*.live.test.ts) hit the real NVIDIA endpoint and cost
    // money + ~seconds per run — run them explicitly:
    //   npx vitest run llm.live context.live
    exclude: ['**/*.live.test.ts', '**/node_modules/**'],
  },
});
