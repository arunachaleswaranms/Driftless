import type { Page } from '@playwright/test';
import { expect, test } from './support.ts';

interface WebAppManifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
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
    // The PNG signature, then the IHDR chunk's width and height.
    const png = await iconResponse.body();
    expect(png.subarray(0, 8).toString('hex'), icon.src).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('ascii'), icon.src).toBe('IHDR');
    expect(`${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}`, icon.src).toBe(
      icon.sizes,
    );
  }

  const faviconHref = await page.locator('link[rel="icon"]').getAttribute('href');
  const favicon = await request.get(new URL(faviconHref ?? '', page.url()).href);
  expect(favicon.ok()).toBe(true);
  expect(favicon.headers()['content-type']).toBe('image/svg+xml');
});

test('keeps the manifest identity, start URL, and scope at the application root', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/');
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestUrl = new URL(manifestHref ?? '', page.url());
  const manifest = (await (await request.get(manifestUrl.href)).json()) as WebAppManifest;

  // Relative members resolve against the manifest's own URL.
  const root = `${baseURL ?? ''}/`;
  for (const member of ['id', 'start_url', 'scope'] as const) {
    expect(new URL(manifest[member] ?? '', manifestUrl).href, member).toBe(root);
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

test('lets the service worker control the page without serving or caching', async ({ page }) => {
  await page.goto('/');
  await waitForServiceWorkerControl(page);

  // A controlled reload: with no fetch handler, the network answers every
  // request and Cache Storage stays empty.
  const responses: { url: string; fromServiceWorker: boolean }[] = [];
  page.on('response', (response) => {
    responses.push({ url: response.url(), fromServiceWorker: response.fromServiceWorker() });
  });
  await page.reload();
  await waitForServiceWorkerControl(page);
  await expect(page.getByRole('region', { name: 'Browser capabilities' })).toBeVisible();

  expect(responses.length).toBeGreaterThan(0);
  expect(responses.filter(({ fromServiceWorker }) => fromServiceWorker)).toEqual([]);
  expect(
    await page.evaluate(async () => ({
      state: (await navigator.serviceWorker.ready).active?.state,
      caches: await caches.keys(),
    })),
  ).toEqual({ state: 'activated', caches: [] });
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
