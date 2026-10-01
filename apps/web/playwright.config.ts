import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const PORT = 4173;
const baseURL = `http://localhost:${String(PORT)}`;
const isCI = Boolean(process.env.CI);

// The browser tests start their own signaling service on loopback, on a
// controlled port that the development default (8787) does not use, and the
// preview server forwards the application's same-origin /v1/signaling path to
// it. Nothing contacts a public signaling, STUN, or TURN service.
const SIGNALING_PORT = Number(process.env.DRIFTLESS_E2E_SIGNALING_PORT ?? '8790');
const SIGNALING_ORIGIN = `http://127.0.0.1:${String(SIGNALING_PORT)}`;

// Playwright's own Chromium always runs. DRIFTLESS_E2E_CHROME=1 also runs
// every test in the Google Chrome installed on this machine, as additional
// development-browser evidence. Neither is a browser support claim.
const projects: PlaywrightTestConfig['projects'] = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
];
if (process.env.DRIFTLESS_E2E_CHROME === '1') {
  projects.push({ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } });
}

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  // The full Chromium build runs Chrome's new headless mode. The separate
  // headless shell does not evaluate installability, so it cannot run the
  // manifest checks meaningfully.
  projects,
  // Smoke tests run against a fresh production build so they exercise the
  // content security policy and service worker registration, which the
  // development server omits. Both servers use strict ports, so a stale
  // server already bound to either fails the run instead of being reused.
  // Playwright stops both when the run ends.
  webServer: [
    {
      command:
        'npm run build --workspace @driftless/signaling && npm run start --workspace @driftless/signaling',
      url: `${SIGNALING_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SIGNALING_HOST: '127.0.0.1',
        SIGNALING_PORT: String(SIGNALING_PORT),
        SIGNALING_ALLOWED_ORIGINS: baseURL,
      },
    },
    {
      command: 'npm run build && npm run preview',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { DRIFTLESS_SIGNALING_TARGET: SIGNALING_ORIGIN },
    },
  ],
});
