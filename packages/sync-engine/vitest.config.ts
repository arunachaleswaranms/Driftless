import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Source tests need no prior build; the dist smoke covers package exports.
    alias: {
      '@driftless/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
});
