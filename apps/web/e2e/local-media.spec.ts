import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support.ts';

// Synthetic fixtures; see e2e/media/README.md. The two WebM files are VP8
// without audio. The MP4 file is H.264 with AAC audio. They qualify local
// playback only, not Progressive Watch.
const MEDIA_DIRECTORY = join(import.meta.dirname, 'media');
interface Fixture {
  path: string;
  name: string;
  type: string;
  size: string;
  duration: string;
  dimensions: string;
  seconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}
const VIDEO_A: Fixture = {
  path: join(MEDIA_DIRECTORY, 'synthetic-320x180-10s.webm'),
  name: 'synthetic-320x180-10s.webm',
  type: 'video/webm',
  size: '15.9 KiB (16,273 bytes)',
  duration: '0:10',
  dimensions: '320 × 180 pixels',
  seconds: 10,
  width: 320,
  height: 180,
  hasAudio: false,
};
const VIDEO_B: Fixture = {
  path: join(MEDIA_DIRECTORY, 'synthetic-256x144-6s.webm'),
  name: 'synthetic-256x144-6s.webm',
  type: 'video/webm',
  size: '6.34 KiB (6,496 bytes)',
  duration: '0:06',
  dimensions: '256 × 144 pixels',
  seconds: 6,
  width: 256,
  height: 144,
  hasAudio: false,
};
const VIDEO_MP4: Fixture = {
  path: join(MEDIA_DIRECTORY, 'synthetic-320x180-8s-h264-aac.mp4'),
  name: 'synthetic-320x180-8s-h264-aac.mp4',
  type: 'video/mp4',
  size: '181 KiB (185,070 bytes)',
  duration: '0:08',
  dimensions: '320 × 180 pixels',
  seconds: 8,
  width: 320,
  height: 180,
  hasAudio: true,
};
const READY = 'Ready. Use the video controls to play, pause, and seek.';

interface MediaProbe {
  created: string[];
  revoked: string[];
  fileReads: string[];
  playCalls: number;
}

declare global {
  interface Window {
    mediaProbe: MediaProbe;
  }
}

// Records object URL ownership, any application-level read of file contents,
// and any script call to play(). The native controls start playback without
// calling the page's play(), so a nonzero count means the page started it.
// Installed before the application loads.
function installMediaProbe() {
  const probe: MediaProbe = { created: [], revoked: [], fileReads: [], playCalls: 0 };
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
  const play: unknown = Reflect.get(HTMLMediaElement.prototype, 'play');
  if (typeof play === 'function') {
    Reflect.set(HTMLMediaElement.prototype, 'play', function (this: HTMLMediaElement) {
      probe.playCalls += 1;
      return Reflect.apply(play, this, []) as unknown;
    });
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

async function expectDetails(page: Page, video: Fixture) {
  await expect(panel(page).getByRole('status')).toHaveText(READY);
  await expect(detail(page, 'Name')).toHaveText(video.name);
  await expect(detail(page, 'Browser-reported type')).toHaveText(video.type);
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

// Playback as the element reports it. The decoded frame count shows that the
// picture advanced, not only the clock. Chromium also counts decoded audio
// bytes; the count is null in a browser that does not expose it.
function playback(video: Locator) {
  return video.evaluate((element: HTMLVideoElement) => {
    const audioBytes: unknown = Reflect.get(element, 'webkitAudioDecodedByteCount');
    return {
      paused: element.paused,
      ended: element.ended,
      currentTime: element.currentTime,
      frames: element.getVideoPlaybackQuality().totalVideoFrames,
      audioBytes: typeof audioBytes === 'number' ? audioBytes : null,
    };
  });
}

// Starts playback with a trusted click and waits until the element has
// played past the given time, decoding new frames on the way.
async function playPast(video: Locator, seconds: number) {
  const before = await playback(video);
  expect(before.paused).toBe(true);
  await video.click();
  await expect.poll(() => currentTime(video)).toBeGreaterThan(seconds);
  const after = await playback(video);
  expect(after).toMatchObject({ paused: false, ended: false });
  expect(after.frames).toBeGreaterThan(before.frames);
  return after;
}

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
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
    await chooser(page).setInputFiles(VIDEO_MP4.path);
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

// The complete Phase 1 local-player lifecycle, once starting from each media
// shape and replacing it with the other. Every step checks what the browser
// actually did, and the whole flow is watched for requests and storage.
for (const [first, second] of [
  [VIDEO_MP4, VIDEO_A],
  [VIDEO_A, VIDEO_MP4],
] as const) {
  test(`runs the full lifecycle from ${first.type} to ${second.type}`, async ({
    page,
    baseURL,
  }) => {
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
    await waitForServiceWorkerControl(page);
    const clear = panel(page).getByRole('button', { name: 'Clear video' });

    // Empty.
    await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
    await expect(player(page)).toHaveCount(0);

    // Select, and the browser reports sensible metadata.
    await chooser(page).setInputFiles(first.path);
    await expectDetails(page, first);
    const video = player(page);
    expect(
      await video.evaluate((element: HTMLVideoElement) => ({
        controls: element.controls,
        playsInline: element.playsInline,
        autoplay: element.autoplay,
        preload: element.preload,
        duration: element.duration,
        width: element.videoWidth,
        height: element.videoHeight,
      })),
    ).toEqual({
      controls: true,
      playsInline: true,
      autoplay: false,
      preload: 'metadata',
      duration: expect.closeTo(first.seconds, 1) as unknown,
      width: first.width,
      height: first.height,
    });

    // Nothing starts playback on its own.
    await page.waitForTimeout(500);
    expect(await playback(video)).toMatchObject({ paused: true, currentTime: 0 });

    // Play after a trusted click.
    await playPast(video, 1);

    // Pause, and time stops.
    await video.click();
    await expect.poll(async () => (await playback(video)).paused).toBe(true);
    const pausedAt = await currentTime(video);
    await page.waitForTimeout(500);
    expect(await currentTime(video)).toBe(pausedAt);

    // Seek forward while paused, then resume from the new position.
    const forward = first.seconds - 2.5;
    expect(await seek(video, forward)).toBeCloseTo(forward, 1);
    const resumed = await playPast(video, forward + 0.5);
    expect(resumed.currentTime).toBeLessThan(first.seconds);

    // Seek backward while playing, and playback continues from there.
    expect(await seek(video, 1.5)).toBeCloseTo(1.5, 1);
    await expect.poll(() => currentTime(video)).toBeGreaterThan(2);
    const rewound = await playback(video);
    expect(rewound).toMatchObject({ paused: false, ended: false });
    expect(rewound.currentTime).toBeLessThan(forward);
    // Audio was decoded only for the file that has an audio track.
    if (rewound.audioBytes !== null) {
      expect(rewound.audioBytes > 0).toBe(first.hasAudio);
    }

    let probe = await readProbe(page);
    expect(probe.created).toHaveLength(1);
    const [firstUrl] = probe.created;
    expect(probe.revoked).toEqual([]);

    // Replace during playback: the previous file is released, and nothing
    // of its state carries over.
    await chooser(page).setInputFiles(second.path);
    await expectDetails(page, second);
    probe = await readProbe(page);
    expect(probe.created).toHaveLength(2);
    expect(probe.revoked).toEqual([firstUrl]);
    expect(probe.active).toEqual([probe.created[1]]);
    await expect(player(page)).toHaveCount(1);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    expect(await mediaState(player(page))).toEqual({
      paused: true,
      currentTime: 0,
      src: probe.created[1],
    });

    // The replacement plays, and its URL stays live while it does.
    await playPast(player(page), 1);
    expect((await readProbe(page)).active).toEqual([probe.created[1]]);

    // Clear.
    await clear.click();
    await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
    await expect(page.locator('video')).toHaveCount(0);
    probe = await readProbe(page);
    expect(probe.active).toEqual([]);
    expect(probe.revoked).toEqual(probe.created);

    // Select again, play, and clear again.
    await chooser(page).setInputFiles(first.path);
    await expectDetails(page, first);
    await playPast(player(page), 0.5);
    await clear.click();
    await expect(panel(page).getByRole('status')).toHaveText('No video selected.');

    // Late events from released files must not alter the empty state.
    await page.waitForTimeout(500);
    await expect(panel(page).getByRole('status')).toHaveText('No video selected.');
    await expect(page.locator('video')).toHaveCount(0);
    probe = await readProbe(page);
    expect(probe.created).toHaveLength(3);
    expect(probe.active).toEqual([]);
    expect(probe.revoked).toHaveLength(3);
    expect(new Set(probe.revoked)).toEqual(new Set(probe.created));
    expect(probe.fileReads).toEqual([]);
    expect(probe.playCalls).toBe(0);

    // Only the application's own static files and the browser's reads of its
    // own object URLs were requested. No request carried a body, a query, or
    // a chosen file name, and the service worker answered none of them.
    const origin = new URL(baseURL ?? '').origin;
    expect(workerResponses).toEqual([]);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(request.method, request.url).toBe('GET');
      expect(request.hasBody, request.url).toBe(false);
      expect(url.origin, request.url).toBe(origin);
      expect(url.search, request.url).toBe('');
      for (const name of [first.name, second.name]) {
        expect(decodeURIComponent(request.url), request.url).not.toContain(name);
      }
      if (url.protocol === 'blob:') {
        expect(probe.created, request.url).toContain(request.url);
      } else {
        expect(url.pathname, request.url).toMatch(
          /^\/($|assets\/|icons\/|manifest\.webmanifest$|sw\.js$)/,
        );
      }
    }

    expect(
      await page.evaluate(async () => {
        const opfsEntries: string[] = [];
        for await (const name of (await navigator.storage.getDirectory()).keys()) {
          opfsEntries.push(name);
        }
        return {
          caches: await caches.keys(),
          opfsEntries,
          databases: (await indexedDB.databases()).map(({ name }) => name),
          localStorage: localStorage.length,
          sessionStorage: sessionStorage.length,
        };
      }),
    ).toEqual({ caches: [], opfsEntries: [], databases: [], localStorage: 0, sessionStorage: 0 });
  });
}

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
  await waitForServiceWorkerControl(page);

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
