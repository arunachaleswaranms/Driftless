import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Unit and integration tests run against the protocol sources, so they need
    // no prior build. The built package is exercised by `npm run smoke:dist`.
    alias: {
      '@driftless/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
