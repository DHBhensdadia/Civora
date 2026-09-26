import { defineConfig } from 'vitest/config';

/**
 * The Firestore rules tests, kept out of `pnpm test` on purpose.
 *
 * They need the emulator running, so they cannot be part of the ordinary suite:
 * a test that fails because a background service is absent teaches people to
 * ignore the suite. `pnpm test:rules` starts the emulator around this config,
 * and `rules-tests/` is outside `vitest.config.ts`'s include patterns so the
 * two can never be confused for each other.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['rules-tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // One shared emulator and one shared project: the suites seed and clear the
    // same documents, so they must not run beside each other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
