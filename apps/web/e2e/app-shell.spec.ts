import type { Page } from '@playwright/test';
import { expect, test } from './support.ts';

interface WebAppManifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: { src: string; sizes: string; type: string; purpose?: string }[];
}

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test('renders the application shell', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Driftless');
  await expect(
    page.getByRole('banner').getByRole('heading', { level: 1, name: 'Driftless' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Local video' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Browser capabilities' })).toBeVisible();
});

test('moves keyboard focus to the main content through a visible skip link', async ({ page }) => {
  await page.goto('/');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });

  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  expect(await skipLink.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );

  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});

test('stacks the layout without horizontal scrolling at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');

  const localMedia = await page.getByRole('region', { name: 'Local video' }).boundingBox();
  const capabilities = await page
    .getByRole('region', { name: 'Browser capabilities' })
    .boundingBox();
  expect(localMedia).not.toBeNull();
  expect(capabilities).not.toBeNull();
  if (localMedia && capabilities) {
    expect(capabilities.y).toBeGreaterThanOrEqual(localMedia.y + localMedia.height);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('places the panels side by side at a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  const localMedia = await page.getByRole('region', { name: 'Local video' }).boundingBox();
  const capabilities = await page
    .getByRole('region', { name: 'Browser capabilities' })
    .boundingBox();
  expect(localMedia).not.toBeNull();
  expect(capabilities).not.toBeNull();
  if (localMedia && capabilities) {
    expect(capabilities.x).toBeGreaterThanOrEqual(localMedia.x + localMedia.width);
    expect(capabilities.y).toBe(localMedia.y);
  }
});

test('links a web app manifest whose icons are served', async ({ page, request }) => {
  await page.goto('/');

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).not.toBeNull();
  const manifestUrl = new URL(manifestHref ?? '', page.url());
  const manifestResponse = await request.get(manifestUrl.href);
  expect(manifestResponse.ok()).toBe(true);

  const manifest = (await manifestResponse.json()) as WebAppManifest;
  expect(manifest).toMatchObject({
    name: 'Driftless',
    short_name: 'Driftless',
    start_url: './',
    display: 'standalone',
  });
  const icons = manifest.icons ?? [];
  expect(icons.map((icon) => `${icon.sizes} ${icon.purpose ?? 'any'}`)).toEqual([
    '192x192 any',
    '512x512 any',
    '512x512 maskable',
  ]);
  for (const icon of icons) {
    const iconResponse = await request.get(new URL(icon.src, manifestUrl).href);
    expect(iconResponse.ok(), icon.src).toBe(true);
    expect(iconResponse.headers()['content-type']).toBe('image/png');
  }
});

test('reports no Chromium manifest or installability errors', async ({ page, baseURL }) => {
  await page.goto('/');
  await waitForServiceWorkerControl(page);
  const cdp = await page.context().newCDPSession(page);

  const manifest = await cdp.send('Page.getAppManifest');
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');

  expect(manifest.url).toBe(`${baseURL ?? ''}/manifest.webmanifest`);
  expect(manifest.errors).toEqual([]);
  // Playwright browser contexts are off-the-record, which Chrome always
  // reports as 'in-incognito'. That describes the test environment, not the
  // application, so it is the only error ignored.
  expect(installabilityErrors.filter(({ errorId }) => errorId !== 'in-incognito')).toEqual([]);
});

test('registers the service worker at the application root', async ({ page, baseURL }) => {
  await page.goto('/');
  await waitForServiceWorkerControl(page);

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, scriptURL: ready.active?.scriptURL };
  });
  expect(registration).toEqual({
    scope: `${baseURL ?? ''}/`,
    scriptURL: `${baseURL ?? ''}/sw.js`,
  });
});

test('applies the production content security policy', async ({ page }) => {
  await page.goto('/');

  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  // The complete policy: media-src adds only blob:, for locally chosen video.
  expect(policy?.split('; ')).toEqual([
    "default-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]);
});
