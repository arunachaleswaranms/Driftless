import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support.ts';

// Synthetic VP8/WebM fixtures without audio; see e2e/media/README.md.
const MEDIA_DIRECTORY = join(import.meta.dirname, 'media');
const VIDEO_A = {
  path: join(MEDIA_DIRECTORY, 'synthetic-320x180-10s.webm'),
  name: 'synthetic-320x180-10s.webm',
  size: '15.9 KiB (16,273 bytes)',
  duration: '0:10',
  dimensions: '320 × 180 pixels',
};
const VIDEO_B = {
  path: join(MEDIA_DIRECTORY, 'synthetic-256x144-6s.webm'),
  name: 'synthetic-256x144-6s.webm',
  size: '6.34 KiB (6,496 bytes)',
  duration: '0:06',
  dimensions: '256 × 144 pixels',
};
const READY = 'Ready. Use the video controls to play, pause, and seek.';

interface MediaProbe {
  created: string[];
  revoked: string[];
  fileReads: string[];
}

declare global {
  interface Window {
    mediaProbe: MediaProbe;
  }
}

// Records object URL ownership and any application-level read of file
// contents. Installed before the application loads.
function installMediaProbe() {
  const probe: MediaProbe = { created: [], revoked: [], fileReads: [] };
  window.mediaProbe = probe;

  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = createObjectURL(object);
    probe.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    probe.revoked.push(url);
    revokeObjectURL(url);
  };

  const prototype = Blob.prototype as unknown as Record<string, unknown>;
  for (const name of ['arrayBuffer', 'bytes', 'text', 'stream', 'slice']) {
    const original = prototype[name];
    if (typeof original === 'function') {
      prototype[name] = function (this: Blob, ...args: unknown[]): unknown {
        probe.fileReads.push(`Blob.${name}`);
        return Reflect.apply(original, this, args) as unknown;
      };
    }
  }
  const OriginalFileReader = window.FileReader;
  window.FileReader = class extends OriginalFileReader {
    constructor() {
      super();
      probe.fileReads.push('FileReader');
    }
  };
}

async function readProbe(page: Page) {
  const probe = await page.evaluate(() => window.mediaProbe);
  return { ...probe, active: probe.created.filter((url) => !probe.revoked.includes(url)) };
}

function panel(page: Page): Locator {
  return page.getByRole('region', { name: 'Local video' });
}

function chooser(page: Page): Locator {
  return panel(page).getByLabel(/video file$/);
}

function player(page: Page): Locator {
  return panel(page).getByLabel('Video player');
}

function detail(page: Page, term: string): Locator {
  return panel(page).locator('dt', { hasText: term }).locator('+ dd');
}

async function expectDetails(page: Page, video: typeof VIDEO_A) {
  await expect(panel(page).getByRole('status')).toHaveText(READY);
  await expect(detail(page, 'Name')).toHaveText(video.name);
  await expect(detail(page, 'Browser-reported type')).toHaveText('video/webm');
  await expect(detail(page, 'Size')).toHaveText(video.size);
  await expect(detail(page, 'Duration')).toHaveText(video.duration);
  await expect(detail(page, 'Video dimensions')).toHaveText(video.dimensions);
}

function mediaState(video: Locator) {
  return video.evaluate((element: HTMLVideoElement) => ({
    paused: element.paused,
    currentTime: element.currentTime,
    src: element.getAttribute('src'),
  }));
}

async function currentTime(video: Locator): Promise<number> {
  return (await mediaState(video)).currentTime;
}

async function seek(video: Locator, seconds: number): Promise<number> {
  return video.evaluate(
    (element: HTMLVideoElement, target) =>
      new Promise<number>((resolve) => {
        element.addEventListener(
          'seeked',
          () => {
            resolve(element.currentTime);
          },
          { once: true },
        );
        element.currentTime = target;
      }),
    seconds,
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMediaProbe);
  await page.goto('/');
});

test('offers a keyboard-accessible file chooser in the empty state', async ({ page }) => {
  await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
  await expect(player(page)).toHaveCount(0);

  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Choose video file')).toBeFocused();
  const label = panel(page).locator('label', { hasText: 'Choose video file' });
  await expect(label).toBeVisible();
  expect(await label.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );
});

test('plays, pauses, and seeks a chosen local file', async ({ page }) => {
  await chooser(page).setInputFiles(VIDEO_A.path);
  await expectDetails(page, VIDEO_A);

  const video = player(page);
  const probe = await readProbe(page);
  expect(probe.created).toHaveLength(1);
  expect(probe.created[0]).toMatch(/^blob:http:\/\/localhost:4173\//);
  expect((await mediaState(video)).src).toBe(probe.created[0]);

  // Nothing starts playback on its own.
  await page.waitForTimeout(500);
  expect(await mediaState(video)).toMatchObject({ paused: true, currentTime: 0 });

  // A trusted click on the video starts playback, and time advances.
  await video.click();
  await expect.poll(() => currentTime(video)).toBeGreaterThan(1);
  expect((await mediaState(video)).paused).toBe(false);

  // A second click pauses it, and time stops.
  await video.click();
  await expect.poll(async () => (await mediaState(video)).paused).toBe(true);
  const pausedAt = await currentTime(video);
  await page.waitForTimeout(500);
  expect(await currentTime(video)).toBe(pausedAt);

  expect(await seek(video, 7.5)).toBeCloseTo(7.5, 1);
  expect(await seek(video, 2)).toBeCloseTo(2, 1);

  await video.click();
  await expect.poll(() => currentTime(video)).toBeGreaterThan(2.5);
  expect(await currentTime(video)).toBeLessThan(7);

  const final = await readProbe(page);
  expect(final.created).toHaveLength(1);
  expect(final.revoked).toEqual([]);
  expect(final.fileReads).toEqual([]);
});

test('plays and pauses from the keyboard', async ({ page }) => {
  await chooser(page).setInputFiles(VIDEO_A.path);
  await expectDetails(page, VIDEO_A);
  const video = player(page);

  await video.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => currentTime(video)).toBeGreaterThan(0.5);

  await page.keyboard.press('Space');
  await expect.poll(async () => (await mediaState(video)).paused).toBe(true);
});

test('replaces the file and releases the previous one', async ({ page }) => {
  await chooser(page).setInputFiles(VIDEO_A.path);
  await expectDetails(page, VIDEO_A);
  const video = player(page);
  await video.click();
  await expect.poll(() => currentTime(video)).toBeGreaterThan(0.5);
  const [firstUrl] = (await readProbe(page)).created;

  await expect(page.getByLabel('Replace video file')).toBeAttached();
  await chooser(page).setInputFiles(VIDEO_B.path);
  await expectDetails(page, VIDEO_B);

  const probe = await readProbe(page);
  expect(probe.created).toHaveLength(2);
  expect(probe.revoked).toEqual([firstUrl]);
  expect(probe.active).toEqual([probe.created[1]]);
  await expect(player(page)).toHaveCount(1);
  expect(await mediaState(player(page))).toEqual({
    paused: true,
    currentTime: 0,
    src: probe.created[1],
  });
  expect(probe.fileReads).toEqual([]);
});

test('clears the file, releases it, and allows choosing it again', async ({ page }) => {
  await chooser(page).setInputFiles(VIDEO_A.path);
  await expectDetails(page, VIDEO_A);
  await player(page).click();
  await expect.poll(() => currentTime(player(page))).toBeGreaterThan(0.5);

  await panel(page).getByRole('button', { name: 'Clear video' }).click();

  await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
  await expect(player(page)).toHaveCount(0);
  await expect(panel(page).getByRole('heading', { name: 'Selected file' })).toHaveCount(0);
  await expect(page.getByLabel('Choose video file')).toBeFocused();
  expect(await page.locator('video').count()).toBe(0);
  let probe = await readProbe(page);
  expect(probe.active).toEqual([]);
  expect(probe.revoked).toEqual(probe.created);

  await chooser(page).setInputFiles(VIDEO_A.path);
  await expectDetails(page, VIDEO_A);
  probe = await readProbe(page);
  expect(probe.created).toHaveLength(2);
  expect(probe.active).toEqual([probe.created[1]]);
});

test('reports a file the browser cannot play', async ({ page }) => {
  await chooser(page).setInputFiles({
    name: 'not-a-video.webm',
    mimeType: 'video/webm',
    buffer: Buffer.from('This is plain text, not video data.\n'.repeat(64)),
  });

  const alert = panel(page).getByRole('alert');
  await expect(alert).toContainText('This browser could not play the selected media.');
  await expect(alert).not.toContainText(/codec|DEMUXER|FFmpeg/i);
  await expect(player(page)).toBeHidden();
  await expect(detail(page, 'Name')).toHaveText('not-a-video.webm');
  await expect(detail(page, 'Duration')).toHaveText('Unavailable');

  await chooser(page).setInputFiles(VIDEO_B.path);
  await expectDetails(page, VIDEO_B);
  await expect(alert).toHaveCount(0);

  await panel(page).getByRole('button', { name: 'Clear video' }).click();
  const probe = await readProbe(page);
  expect(probe.created).toHaveLength(2);
  expect(probe.revoked).toEqual(probe.created);
});

test('releases every object URL across rapid replace and clear cycles', async ({ page }) => {
  const clear = panel(page).getByRole('button', { name: 'Clear video' });

  for (let cycle = 0; cycle < 5; cycle += 1) {
    // Each replacement lands before the previous file's metadata can load.
    await chooser(page).setInputFiles(VIDEO_A.path);
    await chooser(page).setInputFiles(VIDEO_B.path);
    await chooser(page).setInputFiles(VIDEO_A.path);
    await chooser(page).setInputFiles(VIDEO_B.path);
    await expectDetails(page, VIDEO_B);
    await expect(player(page)).toHaveCount(1);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    const probe = await readProbe(page);
    expect(probe.active).toEqual([(await mediaState(player(page))).src]);

    await clear.click();
    await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
  }

  // Late events from replaced files must not have altered the empty state.
  await page.waitForTimeout(500);
  await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
  await expect(player(page)).toHaveCount(0);
  const probe = await readProbe(page);
  expect(probe.created).toHaveLength(20);
  expect(probe.revoked).toHaveLength(20);
  expect(new Set(probe.revoked)).toEqual(new Set(probe.created));
  expect(probe.fileReads).toEqual([]);
});

test('keeps local media on the device', async ({ page, baseURL }) => {
  const requests: { method: string; url: string; hasBody: boolean }[] = [];
  const workerResponses: string[] = [];
  page.on('request', (request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      hasBody: request.postDataBuffer() !== null,
    });
  });
  page.on('response', (response) => {
    if (response.fromServiceWorker()) {
      workerResponses.push(response.url());
    }
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await chooser(page).setInputFiles(VIDEO_A.path);
  await expectDetails(page, VIDEO_A);
  await player(page).click();
  await expect.poll(() => currentTime(player(page))).toBeGreaterThan(1);
  await seek(player(page), 8);
  await chooser(page).setInputFiles(VIDEO_B.path);
  await expectDetails(page, VIDEO_B);
  await panel(page).getByRole('button', { name: 'Clear video' }).click();

  const origin = new URL(baseURL ?? '').origin;
  expect(requests.length).toBeGreaterThan(0);
  expect(workerResponses).toEqual([]);
  for (const request of requests) {
    expect(request.method, request.url).toBe('GET');
    expect(request.hasBody, request.url).toBe(false);
    expect(new URL(request.url).origin, request.url).toBe(origin);
  }
  // The only media requests are the browser reading its own object URLs.
  const mediaRequests = requests.filter(({ url }) => url.startsWith('blob:'));
  const { created } = await readProbe(page);
  expect(mediaRequests.length).toBeGreaterThan(0);
  expect(mediaRequests.every(({ url }) => created.includes(url))).toBe(true);

  const stored = await page.evaluate(async () => {
    const opfsEntries: string[] = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) {
      opfsEntries.push(name);
    }
    return {
      caches: await caches.keys(),
      opfsEntries,
      databases: (await indexedDB.databases()).map(({ name }) => name),
    };
  });
  expect(stored).toEqual({ caches: [], opfsEntries: [], databases: [] });
});

for (const viewport of [
  { width: 360, height: 740 },
  { width: 1280, height: 800 },
]) {
  test(`fits the player and details at ${String(viewport.width)} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await chooser(page).setInputFiles({
      name: `${'a-very-long-file-name-without-spaces-'.repeat(6)}.webm`,
      mimeType: 'video/webm',
      buffer: readFileSync(VIDEO_A.path),
    });
    await expect(panel(page).getByRole('status')).toHaveText(READY);

    const region = await panel(page).boundingBox();
    const video = await player(page).boundingBox();
    const name = await detail(page, 'Name').boundingBox();
    expect(region).not.toBeNull();
    expect(video).not.toBeNull();
    expect(name).not.toBeNull();
    if (region && video && name) {
      expect(video.width).toBeGreaterThan(0);
      expect(video.x).toBeGreaterThanOrEqual(region.x);
      expect(video.x + video.width).toBeLessThanOrEqual(region.x + region.width);
      expect(name.x + name.width).toBeLessThanOrEqual(region.x + region.width);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
}
