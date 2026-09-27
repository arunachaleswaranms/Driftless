import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const baseURL = `http://localhost:${String(PORT)}`;
const isCI = Boolean(process.env.CI);

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  // Smoke tests run against a fresh production build so they exercise the
  // content security policy and service worker registration, which the
  // development server omits. The preview server uses a strict port, so a
  // stale server already bound to it fails the run instead of being reused.
  webServer: {
    command: 'npm run build && npm run preview',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
