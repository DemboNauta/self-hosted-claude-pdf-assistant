import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Ingestion boots a PDF.js worker thread through tsx, which is slow on cold Windows runs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
