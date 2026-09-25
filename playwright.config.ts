import { defineConfig, devices } from '@playwright/test';

/**
 * A port that will not collide with a development server someone already has
 * running on 3000.
 */
const PORT = Number(process.env.CIVORA_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;
const isCI = process.env.CI !== undefined && process.env.CI !== '';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Browser tests run against the production build in exactly the form the
    // container serves, including the local adapters a deployer gets with no
    // credentials configured. Run `pnpm build` first.
    command: 'node scripts/serve-standalone.mjs',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      CIVORA_DATA_PROVIDER: 'in-memory',
      CIVORA_AUTH_PROVIDER: 'fixture',
      CIVORA_REASONING_PROVIDER: 'fixture',
    },
  },
});
