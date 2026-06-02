import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
    reporters: ['default'],
  },
});
