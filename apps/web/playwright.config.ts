import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const PORT = 4173;
const baseURL = `http://localhost:${String(PORT)}`;
const isCI = Boolean(process.env.CI);

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
  // development server omits. The preview server uses a strict port, so a
  // stale server already bound to it fails the run instead of being reused.
  webServer: {
    command: 'npm run build && npm run preview',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
