import { defineConfig, devices } from '@playwright/test';

/**
 * A port that will not collide with a development server someone already has
 * running on 3000.
 */
const PORT = Number(process.env.CIVORA_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;
const isCI = process.env.CI !== undefined && process.env.CI !== '';

/**
 * The adapter the server under test runs.
 *
 * `fixture` by default, and deliberately: every suite in `e2e/` that is not the
 * gated `live-ai.spec.ts` asserts the platform's own rules and must not depend on
 * a model, a key or a quota. A live run asks for the other adapter explicitly
 * (`CIVORA_LIVE_AI=1`), and the credentials go with it — a key is never needed
 * for the default shape of this file.
 */
const liveAi = process.env.CIVORA_LIVE_AI === '1';

if (
  liveAi &&
  (process.env.GEMINI_API_KEY === undefined || process.env.GEMINI_MODEL === undefined)
) {
  // A sentence rather than a server that never answers: the live suites need the
  // credentials to reach the process this config starts, and they are never read
  // from a file here so a stray `.env.local` cannot silently arm a live run.
  throw new Error(
    'CIVORA_LIVE_AI=1 needs GEMINI_API_KEY and GEMINI_MODEL in the environment, because the server this config starts is the one that calls the model',
  );
}

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
      CIVORA_REASONING_PROVIDER: liveAi ? 'gemini' : 'fixture',
      ...(liveAi && process.env.GEMINI_API_KEY !== undefined
        ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY }
        : {}),
      ...(liveAi && process.env.GEMINI_MODEL !== undefined
        ? { GEMINI_MODEL: process.env.GEMINI_MODEL }
        : {}),
    },
  },
});
