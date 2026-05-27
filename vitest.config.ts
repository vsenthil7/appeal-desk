import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      // The testable surface: all pure/injectable logic. The Devvit *.tsx
      // glue (UI components, menu, triggers, scheduler, entrypoint) is thin
      // wiring exercised via playtest, so it's excluded from the unit target.
      include: [
        'src/core/**/*.ts',
        'src/ai/**/*.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
