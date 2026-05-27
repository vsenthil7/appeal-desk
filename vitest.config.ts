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
      exclude: [
        'src/core/**/*.test.ts',
      ],
      thresholds: {
        // Coverage floors. The lines/statements/branches floors are set just
        // below the measured maximum so a regression that drops coverage will
        // fail CI, but the existing genuinely-unreachable defensive arms
        // (every one of them annotated inline with `/* v8 ignore */` and a
        // rationale) don't block the build.
        //
        // Concretely, the few branches NOT at 100% are:
        //   - `cause: e instanceof Error ? e.message : String(e)` in
        //     `store.ts safeGet` — `this.get` only throws AppealError, so the
        //     non-Error arm is unreachable.
        //   - `full?.targetId ?? ''` in `service.ts` cooldown enrichment —
        //     `priorAppeals` filters out missing records via `safeGet`, so the
        //     nullish arm is race-defensive, not reachable in normal flow.
        //   - A handful of nullish-coalesce arms in `observability` percentile
        //     code that are belt-and-braces against future sparse-array refactors.
        //
        // Every other reachable line, function, and branch is at 100%.
        lines: 99.9,
        functions: 100,
        branches: 99,
        statements: 99.9,
      },
    },
  },
});
