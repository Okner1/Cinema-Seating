import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share a single Postgres database, so they must not
    // run concurrently across files.
    fileParallelism: false,
  },
});
