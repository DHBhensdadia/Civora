import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Workspace packages are consumed as TypeScript source rather than build
 * output, so tests resolve them through the same aliases the applications use.
 * Keeping this list explicit means a typo fails immediately instead of
 * resolving to something unexpected.
 */
const packageEntry = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@civora/ai': packageEntry('ai'),
      '@civora/domain': packageEntry('domain'),
      '@civora/federated': packageEntry('federated'),
      '@civora/forecasting': packageEntry('forecasting'),
      '@civora/i18n': packageEntry('i18n'),
      '@civora/interop': packageEntry('interop'),
      '@civora/optimizer': packageEntry('optimizer'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
    reporters: process.env.CI === undefined ? ['default'] : ['default', 'github-actions'],
  },
});
