import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entrypoint only wires things together and starts listening.
      exclude: ['src/server.ts'],
      reporter: ['text-summary', 'lcov'],
      // A floor just under today's numbers. Raise it as coverage improves, never lower it.
      thresholds: { lines: 78, statements: 77, functions: 72, branches: 68 },
    },
  },
});
