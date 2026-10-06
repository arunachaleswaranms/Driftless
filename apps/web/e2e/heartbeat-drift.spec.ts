import { parsePeerMessage, type SyncHeartbeat, type SyncMessage } from '@driftless/protocol';
import { test, expect } from './support.ts';
import {
  closePeers,
  expectConnected,
  breakDataChannel,
  dropSignaling,
  identities,
  status,
  CONNECTED_STATUS,
  type Peer,
} from './room-support.ts';
import {
  panel,
  media,
  pair,
  ready,
  commands,
  playing,
  paused,
  privacy,
  injectPeerMessage,
} from './playback-support.ts';
async function syncMessages(p: Peer): Promise<SyncMessage[]> {
  const sends = await p.page.evaluate(() => window.rtcProbe.controlSends.map((s) => s.text));
  return sends.flatMap((s) => {
    const parsed = parsePeerMessage(s);
    return parsed.ok && parsed.message.type === 'SYNC' ? [parsed.message] : [];
  });
}
async function estimate(host: Peer, guest: Peer) {
  await expect
    .poll(async () => {
      const p = (await syncMessages(host)).at(-1)?.payload;
      return p?.phase === 'HEARTBEAT' && p.clockOffsetMs !== null;
    })
    .toBe(true);
  expect((await syncMessages(guest)).every((m) => m.payload.phase === 'OBSERVATION')).toBe(true);
}
async function rate(p: Peer) {
  return media(p).evaluate((v: HTMLVideoElement) => v.playbackRate);
}
async function perturb(guest: Peer, delta: number) {
  await media(guest).evaluate((v: HTMLVideoElement, d) => {
    v.currentTime += d;
  }, delta);
}
async function latest(host: Peer): Promise<SyncHeartbeat> {
  const p = (await syncMessages(host)).at(-1)?.payload;
  if (!p || p.phase !== 'HEARTBEAT') throw new Error('no heartbeat');
  return p;
}
test.afterEach(closePeers);
test('3C heartbeat observation clock estimate and sustained normal rate budget', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await expect
    .poll(async () => (await syncMessages(host)).length, { timeout: 7000 })
    .toBeGreaterThanOrEqual(8);
  const heartbeats = await syncMessages(host);
  const observations = await syncMessages(guest);
  expect(heartbeats[0]?.payload).toMatchObject({
    phase: 'HEARTBEAT',
    syncSequence: 1,
    clockOffsetMs: null,
    roundTripMs: null,
    revision: 1,
    mode: 'paused',
  });
  expect(observations.length).toBeGreaterThanOrEqual(7);
  for (const messages of [heartbeats, observations]) {
    const timestamps = messages.map((m) =>
      m.payload.phase === 'HEARTBEAT' ? m.payload.capturedAtMs : m.payload.guestSentAtMs,
    );
    const seconds = ((timestamps.at(-1) ?? 0) - (timestamps[0] ?? 0)) / 1000;
    expect((messages.length - 1) / seconds).toBeLessThan(3);
  }
  expect(heartbeats.map((m) => m.payload.syncSequence)).toEqual(heartbeats.map((_, i) => i + 1));
  await expectConnected(host, guest);
  await privacy(host, guest);
});
test('3C small settled drift keeps 1x without local seek', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  // Forward seeked event count before perturbation; exact boundaries belong to unit vectors.
  await guest.page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) throw new Error('no video');
    v.dataset.seeks = '0';
    v.addEventListener('seeked', () => {
      v.dataset.seeks = String(Number(v.dataset.seeks) + 1);
    });
  });
  await perturb(guest, -0.03);
  const before = (await syncMessages(host)).length;
  await expect.poll(async () => (await syncMessages(host)).length).toBeGreaterThan(before + 1);
  expect(await rate(guest)).toBe(1);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => Number(v.dataset.seeks))).toBe(1);
  expect((await commands(host)).map((m) => m.type)).toEqual(['PAUSE', 'PLAY']);
  await privacy(host, guest);
});
test('3C guest behind speeds up and fresh host Pause resets rate; repeat stability scenario', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  // Let playback advance enough to place the guest behind without clamping at zero.
  await expect
    .poll(() => media(guest).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.6);
  await perturb(guest, -0.35);
  await expect.poll(() => rate(guest), { intervals: [30, 50, 100] }).toBe(1.05);
  expect(await rate(host)).toBe(1);
  expect((await commands(host)).map((m) => m.type)).toEqual(['PAUSE', 'PLAY']);
  await paused(host, guest);
  expect(await rate(guest)).toBe(1);
  expect((await commands(host)).map((m) => m.type)).toEqual(['PAUSE', 'PLAY', 'PAUSE']);
  await privacy(host, guest);
});
test('3C guest ahead slows down without authority and host Seek resets rate', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  await perturb(guest, 0.35);
  await expect.poll(() => rate(guest), { intervals: [30, 50, 100] }).toBe(0.95);
  expect(await rate(host)).toBe(1);
  expect((await commands(host)).map((m) => m.type)).toEqual(['PAUSE', 'PLAY']);
  await panel(host).getByRole('slider', { name: 'Seek position' }).fill('2000');
  await panel(host).getByRole('button', { name: 'Seek', exact: true }).click();
  await expect.poll(async () => (await commands(host)).at(-1)?.type).toBe('SEEK');
  expect(await rate(guest)).toBe(1);
  expect(await rate(host)).toBe(1);
  await privacy(host, guest);
});
test('3C large guest drift hard seeks locally, host remains unaffected', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  const hostBefore = await media(host).evaluate((v: HTMLVideoElement) => v.currentTime);
  await perturb(guest, 1.5);
  await expect
    .poll(
      async () => {
        const h = await media(host).evaluate((v: HTMLVideoElement) => v.currentTime);
        const g = await media(guest).evaluate((v: HTMLVideoElement) => v.currentTime);
        return Math.abs(g - h);
      },
      { intervals: [50, 100] },
    )
    .toBeLessThan(0.25);
  expect(await rate(guest)).toBe(1);
  expect(await rate(host)).toBe(1);
  expect(await media(host).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(
    hostBefore,
  );
  expect((await commands(host)).map((m) => m.type)).toEqual(['PAUSE', 'PLAY']);
  await privacy(host, guest);
});
test('3C paused guest drift aligns without play or extra host SEEK', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  await paused(host, guest);
  const target = await media(host).evaluate((v: HTMLVideoElement) => v.currentTime);
  await perturb(guest, 0.5);
  await expect
    .poll(() =>
      media(guest).evaluate((v: HTMLVideoElement, t) => Math.abs(v.currentTime - t), target),
    )
    .toBeLessThan(0.1);
  for (const p of [host, guest]) {
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    expect(await rate(p)).toBe(1);
  }
  expect((await commands(host)).map((m) => m.type)).toEqual(['PAUSE', 'PLAY', 'PAUSE']);
  await privacy(host, guest);
});
test('3C stale Ready-cycle SYNC fresh transport sequence is powerless', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  const old = (await syncMessages(host))[0];
  if (!old) throw new Error('no heartbeat');
  await panel(guest).getByRole('button', { name: 'Not ready', exact: true }).click();
  await expect(panel(host).getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
  await media(host).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 4;
  });
  await panel(guest).getByRole('button', { name: "I'm ready", exact: true }).click();
  await expect(panel(host).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect
    .poll(() => media(guest).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(4, 2);
  await estimate(host, guest);
  const before = (await syncMessages(guest)).length;
  await guest.page.evaluate(() => {
    window.rtcProbe.channels.at(-1)?.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const m = JSON.parse(event.data) as { type: string; payload: { syncSequence?: number } };
      const video = document.querySelector('video');
      if (m.type === 'SYNC' && m.payload.syncSequence === 99999 && video) {
        video.dataset.stalePosition = String(video.currentTime);
        video.dataset.staleRate = String(video.playbackRate);
      }
    });
  });
  await injectPeerMessage(host, {
    ...old,
    payload: {
      ...old.payload,
      syncSequence: 99999,
      revision: 1,
      mode: 'paused',
      positionMs: 1000,
    } as SyncMessage['payload'],
  });
  await expect
    .poll(() => media(guest).evaluate((v: HTMLVideoElement) => Number(v.dataset.stalePosition)))
    .toBe(4);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => Number(v.dataset.staleRate))).toBe(1);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(4, 2);
  expect(await rate(guest)).toBe(1);
  expect((await commands(host)).at(-1)?.payload.revision).toBe(1);
  // New-cycle heartbeats remain eligible even after the old high sample id.
  await expect.poll(async () => (await syncMessages(guest)).length).toBeGreaterThan(before);
  await expectConnected(host, guest);
  await privacy(host, guest);
});
test('3C fresh peer recovery stops sync clears correction and rebuilds from sequence 1 null estimate', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  await perturb(guest, 0.35);
  await expect.poll(() => rate(guest)).toBe(0.95);
  const old = await latest(host);
  await breakDataChannel(guest);
  for (const p of [host, guest]) {
    await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    expect(await rate(p)).toBe(1);
    await expect(status(p.page)).toHaveText(CONNECTED_STATUS, { timeout: 20000 });
    expect(await p.page.evaluate(() => window.rtcProbe.channels.length)).toBe(2);
    await expect(panel(p).getByRole('button', { name: "I'm ready", exact: true })).toBeEnabled();
  }
  const stopped = (await syncMessages(host)).length;
  // No heartbeat before new Ready: wait on browser clock without changing production scheduler.
  await guest.page.waitForTimeout(600);
  expect((await syncMessages(host)).length).toBe(stopped);
  await ready(host, guest);
  await expect.poll(async () => (await syncMessages(host)).length).toBeGreaterThan(stopped);
  const first = (await syncMessages(host))[stopped]?.payload;
  if (!first) throw new Error('no heartbeat');
  expect(first).toMatchObject({
    syncSequence: 1,
    revision: 1,
    mode: 'paused',
    clockOffsetMs: null,
    roundTripMs: null,
  });
  expect(first.localReadinessId).not.toBe(old.localReadinessId);
  expect(first.remoteReadinessId).not.toBe(old.remoteReadinessId);
  await estimate(host, guest);
  await privacy(host, guest);
});
test('3C signaling-only reconnect preserves heartbeat cycle revision and usable correction', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await estimate(host, guest);
  await playing(host, guest);
  await expect.poll(async () => (await latest(host)).mode).toBe('playing');
  const before = await latest(host);
  const authority = await commands(host);
  await dropSignaling(guest);
  await expect.poll(() => identities(guest).length, { timeout: 20000 }).toBe(2);
  await expect(status(guest.page)).toHaveText(CONNECTED_STATUS);
  await expect
    .poll(async () => (await latest(host)).syncSequence)
    .toBeGreaterThan(before.syncSequence);
  const after = await latest(host);
  expect(after).toMatchObject({
    localReadinessId: before.localReadinessId,
    remoteReadinessId: before.remoteReadinessId,
    revision: before.revision,
  });
  expect(after.clockOffsetMs).not.toBeNull();
  expect(await commands(host)).toEqual(authority);
  for (const p of [host, guest]) {
    expect(await p.page.evaluate(() => window.rtcProbe.channels.length)).toBe(1);
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  }
  await perturb(guest, 0.35);
  await expect.poll(() => rate(guest), { intervals: [30, 50, 100] }).toBe(0.95);
  await privacy(host, guest);
});
