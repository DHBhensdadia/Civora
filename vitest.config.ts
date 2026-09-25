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

const subpathEntry = (name: string, subpath: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/${subpath}/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@civora/ai/eval': subpathEntry('ai', 'eval'),
      '@civora/ai': packageEntry('ai'),
      // Declared before `@civora/domain`, because a plain alias matches by
      // prefix and the subpath would otherwise be rewritten into the entry.
      '@civora/domain/testing': subpathEntry('domain', 'testing'),
      '@civora/domain': packageEntry('domain'),
      '@civora/federated': packageEntry('federated'),
      '@civora/forecasting': packageEntry('forecasting'),
      '@civora/i18n': packageEntry('i18n'),
      '@civora/interop': packageEntry('interop'),
      '@civora/optimizer': packageEntry('optimizer'),
      '@civora/simulator': fileURLToPath(new URL('./apps/simulator/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
    reporters: process.env.CI === undefined ? ['default'] : ['default', 'github-actions'],
  },
});
