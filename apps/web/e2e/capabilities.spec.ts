import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support.ts';

// These tests compare the report with the test browser's own globals rather
// than assuming which APIs Chromium exposes. Their results are development
// evidence only, not a browser support claim.

const CAPABILITIES = {
  'Secure context': ['window.isSecureContext'],
  'Local file objects': ['File', 'Blob'],
  'Object URLs': ['URL.createObjectURL', 'URL.revokeObjectURL'],
  'HTML video': [
    'HTMLVideoElement',
    'HTMLMediaElement.prototype.play',
    'HTMLMediaElement.prototype.pause',
    'HTMLMediaElement.prototype.canPlayType',
  ],
  'Service Worker API': ['navigator.serviceWorker'],
  'WebRTC peer connection': ['RTCPeerConnection'],
  'WebRTC data channel': ['RTCPeerConnection.prototype.createDataChannel', 'RTCDataChannel'],
  'Media Source Extensions': ['MediaSource', 'MediaSource.isTypeSupported', 'SourceBuffer'],
  'Origin private file system': ['navigator.storage.getDirectory'],
  'Web Crypto digest': ['crypto.subtle', 'crypto.subtle.digest'],
} as const;

function panel(page: Page): Locator {
  return page.getByRole('region', { name: 'Browser capabilities' });
}

function statusFor(page: Page, name: string): Locator {
  return panel(page).locator('dt', { hasText: name }).locator('+ dd');
}

function checkFor(page: Page, capability: string, api: string): Locator {
  return panel(page)
    .getByRole('list', { name: `${capability} checks` })
    .getByRole('listitem')
    .filter({ has: page.locator('code').getByText(api, { exact: true }) });
}

async function expectReportRendered(page: Page) {
  await expect(statusFor(page, 'Web Crypto digest')).toHaveText(
    /^(Available|Not available|Not evaluated)$/,
  );
}

// Resolves each API directly in the page, independently of the
// application's detector. Returns the flag's value for isSecureContext and
// whether an object or function is present for everything else.
function observeRuntime(apis: string[]) {
  const scope = window as unknown as Record<string, unknown>;
  const present: Record<string, boolean> = {};
  for (const api of apis) {
    let value: unknown = scope;
    for (const key of api.replace(/^window\./, '').split('.')) {
      value =
        (typeof value === 'object' || typeof value === 'function') && value !== null
          ? (value as Record<string, unknown>)[key]
          : undefined;
    }
    present[api] =
      api === 'window.isSecureContext'
        ? value === true
        : typeof value === 'function' || (typeof value === 'object' && value !== null);
  }
  const video = document.createElement('video');
  return {
    present,
    canPlayType: {
      'video/mp4': video.canPlayType('video/mp4'),
      'video/webm': video.canPlayType('video/webm'),
    },
  };
}

test('reports populated observations with the support disclaimer', async ({ page }) => {
  await page.goto('/');
  await expectReportRendered(page);

  await expect(panel(page)).not.toContainText('does not check browser capabilities');
  await expect(panel(page)).toContainText('API presence is not browser or product support');
  await expect(panel(page)).toContainText(
    'Their presence does not establish that Progressive Watch, synchronized watching, or any other later feature will work in this browser.',
  );
  await expect(panel(page).getByRole('heading', { level: 3 })).toHaveText([
    'Current foundation',
    'Later-phase prerequisites',
  ]);
  await expect(panel(page).locator('dt')).toHaveText(Object.keys(CAPABILITIES));

  const text = (await panel(page).textContent()) ?? '';
  expect(text).not.toMatch(/\b(un)?supported\b/i);
  expect(text).not.toMatch(/\b(in)?compatib/i);
});

test('matches the browser globals observed independently', async ({ page }) => {
  await page.goto('/');
  await expectReportRendered(page);
  const runtime = await page.evaluate(observeRuntime, Object.values(CAPABILITIES).flat());

  for (const [capability, apis] of Object.entries(CAPABILITIES)) {
    const secure = capability === 'Secure context';
    for (const api of apis) {
      const present = runtime.present[api] ?? false;
      const expected = secure ? String(present) : present ? 'present' : 'not present';
      await expect(checkFor(page, capability, api), api).toHaveText(`${api}: ${expected}`);
    }
    const allPresent = apis.every((api) => runtime.present[api]);
    const expectedStatus = secure
      ? allPresent
        ? 'Yes'
        : 'No'
      : allPresent
        ? 'Available'
        : 'Not available';
    await expect(statusFor(page, capability), capability).toHaveText(expectedStatus);
  }

  const declarations = panel(page).getByRole('list', { name: 'Media type declarations' });
  const answers = Object.entries(runtime.canPlayType).map(
    ([mimeType, answer]) => `${mimeType}: Browser reports: ${answer === '' ? 'no' : answer}`,
  );
  await expect(declarations.getByRole('listitem')).toHaveText(answers);
});

interface EffectProbe {
  installed: boolean;
  wrapped: number;
  calls: string[];
}

declare global {
  interface Window {
    effectProbe: EffectProbe;
  }
}

// Records every call that could prompt the user, create storage, start
// networking, or start a worker. Installed before the application loads.
function installEffectProbe() {
  const probe: EffectProbe = { installed: false, wrapped: 0, calls: [] };
  window.effectProbe = probe;
  const { calls } = probe;

  function wrapMethod(owner: object, name: string, label: string) {
    const original: unknown = Reflect.get(owner, name);
    if (typeof original !== 'function') {
      return;
    }
    Reflect.set(owner, name, function (this: unknown, ...args: unknown[]): unknown {
      calls.push(label);
      return Reflect.apply(original, this, args) as unknown;
    });
    probe.wrapped += 1;
  }

  function wrapConstructor(name: string) {
    const original: unknown = Reflect.get(window, name);
    if (typeof original !== 'function') {
      return;
    }
    Reflect.set(
      window,
      name,
      new Proxy(original, {
        construct(target, args, newTarget) {
          calls.push(`new ${name}`);
          return Reflect.construct(target, args, newTarget) as object;
        },
        apply(target, thisArg, args) {
          calls.push(name);
          return Reflect.apply(target, thisArg, args) as unknown;
        },
      }),
    );
    probe.wrapped += 1;
  }

  for (const name of [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'MediaSource',
    'Worker',
    'SharedWorker',
    'WebSocket',
    'EventSource',
    'XMLHttpRequest',
  ]) {
    wrapConstructor(name);
  }
  for (const name of ['createDataChannel', 'createOffer', 'setLocalDescription']) {
    wrapMethod(RTCPeerConnection.prototype, name, `RTCPeerConnection.${name}`);
  }
  wrapMethod(MediaSource, 'isTypeSupported', 'MediaSource.isTypeSupported');
  wrapMethod(StorageManager.prototype, 'getDirectory', 'navigator.storage.getDirectory');
  wrapMethod(StorageManager.prototype, 'persist', 'navigator.storage.persist');
  wrapMethod(StorageManager.prototype, 'estimate', 'navigator.storage.estimate');
  wrapMethod(Permissions.prototype, 'query', 'navigator.permissions.query');
  wrapMethod(MediaDevices.prototype, 'getUserMedia', 'navigator.mediaDevices.getUserMedia');
  wrapMethod(MediaDevices.prototype, 'getDisplayMedia', 'navigator.mediaDevices.getDisplayMedia');
  wrapMethod(MediaDevices.prototype, 'enumerateDevices', 'navigator.mediaDevices.enumerateDevices');
  wrapMethod(Notification, 'requestPermission', 'Notification.requestPermission');
  wrapMethod(Geolocation.prototype, 'getCurrentPosition', 'geolocation.getCurrentPosition');
  wrapMethod(SubtleCrypto.prototype, 'digest', 'crypto.subtle.digest');
  wrapMethod(CacheStorage.prototype, 'open', 'caches.open');
  wrapMethod(IDBFactory.prototype, 'open', 'indexedDB.open');
  wrapMethod(Storage.prototype, 'setItem', 'Storage.setItem');
  wrapMethod(Navigator.prototype, 'sendBeacon', 'navigator.sendBeacon');
  wrapMethod(window, 'fetch', 'fetch');
  wrapMethod(URL, 'createObjectURL', 'URL.createObjectURL');
  probe.installed = true;
}

test('observes without prompting, networking, or opening anything', async ({ page, baseURL }) => {
  const dialogs: string[] = [];
  const requests: { method: string; url: string }[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  page.on('request', (request) => {
    requests.push({ method: request.method(), url: request.url() });
  });
  await page.addInitScript(installEffectProbe);

  await page.goto('/');
  await expectReportRendered(page);
  await page.reload();
  await expectReportRendered(page);

  const probe = await page.evaluate(() => window.effectProbe);
  // The probe installed completely, so an empty call list is meaningful.
  expect(probe.installed).toBe(true);
  expect(probe.wrapped).toBeGreaterThanOrEqual(28);
  expect(probe.calls).toEqual([]);
  expect(dialogs).toEqual([]);

  // Only the application's own static files are requested.
  const origin = new URL(baseURL ?? '').origin;
  expect(requests.length).toBeGreaterThan(0);
  for (const { method, url } of requests) {
    const parsed = new URL(url);
    expect(method, url).toBe('GET');
    expect(parsed.origin, url).toBe(origin);
    expect(parsed.pathname, url).toMatch(/^\/($|assets\/|icons\/|manifest\.webmanifest$|sw\.js$)/);
  }
});

async function storageSnapshot(page: Page) {
  return page.evaluate(async () => {
    const opfsEntries: string[] = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) {
      opfsEntries.push(name);
    }
    return {
      caches: await caches.keys(),
      databases: (await indexedDB.databases()).map(({ name }) => name),
      opfsEntries,
      localStorage: localStorage.length,
      sessionStorage: sessionStorage.length,
    };
  });
}

test('leaves browser storage unchanged', async ({ page }) => {
  const empty = { caches: [], databases: [], opfsEntries: [], localStorage: 0, sessionStorage: 0 };
  // A blank page on the application's origin, served by the test, so storage
  // can be inspected before the application has ever run.
  await page.route('/storage-baseline', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Baseline</title><link rel="icon" href="data:,">',
    }),
  );
  await page.goto('/storage-baseline');
  expect(await storageSnapshot(page)).toEqual(empty);

  await page.goto('/');
  await expectReportRendered(page);
  expect(await storageSnapshot(page)).toEqual(empty);

  await page.reload();
  await expectReportRendered(page);
  expect(await storageSnapshot(page)).toEqual(empty);
});

test('gives the same report after a reload', async ({ page }) => {
  await page.goto('/');
  await expectReportRendered(page);
  const first = await panel(page).innerText();

  await page.reload();
  await expectReportRendered(page);
  expect(await panel(page).innerText()).toBe(first);
});

for (const viewport of [
  { width: 360, height: 740 },
  { width: 1280, height: 800 },
]) {
  test(`fits the capability report at ${String(viewport.width)} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expectReportRendered(page);

    const region = await panel(page).boundingBox();
    expect(region).not.toBeNull();
    const boxes = await panel(page)
      .locator('code, dt, dd')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { left, right } = element.getBoundingClientRect();
          return { text: element.textContent, left, right };
        }),
      );
    expect(boxes.length).toBeGreaterThan(0);
    if (region) {
      for (const box of boxes) {
        expect(box.left, box.text).toBeGreaterThanOrEqual(region.x);
        expect(box.right, box.text).toBeLessThanOrEqual(region.x + region.width);
      }
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
}
