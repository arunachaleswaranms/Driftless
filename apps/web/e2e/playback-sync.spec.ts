import { readFileSync } from 'node:fs';
import type { PlaybackMessage } from '@driftless/protocol';
import { parsePeerMessage, MAX_PEER_MESSAGE_BYTES } from '@driftless/protocol';
import { test, expect } from './support.ts';
import {
  openPeer,
  closePeers,
  createRoom,
  join,
  expectConnected,
  breakDataChannel,
  dropSignaling,
  identities,
  status,
  CONNECTED_STATUS,
  EMPTY_STORAGE,
  storageSnapshot,
  type Peer,
} from './room-support.ts';
const mp4 = readFileSync(new URL('./media/synthetic-320x180-8s-h264-aac.mp4', import.meta.url));
const panel = (p: Peer) => p.page.getByRole('region', { name: 'Local Sync setup' });
const media = (p: Peer) => p.page.locator('video');
async function select(p: Peer) {
  await p.page
    .locator('input[type=file]')
    .setInputFiles({ name: 'private-playback.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(p.page.getByRole('region', { name: 'Local video' }).getByRole('status')).toHaveText(
    'Ready. Use the video controls to play, pause, and seek.',
  );
}
async function matching(host: Peer, guest: Peer) {
  for (const p of [host, guest])
    await expect(panel(p).getByRole('button', { name: "I'm ready", exact: true })).toBeEnabled();
}
async function ready(host: Peer, guest: Peer) {
  await matching(host, guest);
  for (const p of [host, guest])
    await panel(p).getByRole('button', { name: "I'm ready", exact: true }).click();
  await expect(panel(host).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(panel(guest).getByText('The host controls playback.')).toBeVisible();
  for (const p of [host, guest])
    await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
}
async function pair(
  browser: Parameters<typeof openPeer>[0],
  baseURL: string | undefined,
  problems: string[],
  activate = true,
) {
  const host = await openPeer(browser, baseURL, problems);
  const guest = await openPeer(browser, baseURL, problems);
  const invite = await createRoom(host);
  await join(guest, invite.roomId, invite.inviteSecret);
  await expectConnected(host, guest);
  await select(host);
  await select(guest);
  await matching(host, guest);
  if (activate) await ready(host, guest);
  return { host, guest };
}
async function commands(p: Peer): Promise<PlaybackMessage[]> {
  const sends = await p.page.evaluate(() => window.rtcProbe.controlSends.map((s) => s.text));
  return sends.flatMap((text) => {
    const parsed = parsePeerMessage(text);
    return parsed.ok && ['PLAY', 'PAUSE', 'SEEK'].includes(parsed.message.type)
      ? [parsed.message as PlaybackMessage]
      : [];
  });
}
async function playing(host: Peer, guest: Peer) {
  await panel(host).getByRole('button', { name: 'Play', exact: true }).click();
  for (const p of [host, guest])
    await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
}
async function paused(host: Peer, guest: Peer) {
  await panel(host).getByRole('button', { name: 'Pause', exact: true }).click();
  for (const p of [host, guest])
    await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
}
async function commitSeek(host: Peer, guest: Peer, target: number, isPaused: boolean) {
  const before = (await commands(host)).length;
  const range = panel(host).getByRole('slider', { name: 'Seek position' });
  await range.fill(String(target));
  expect((await commands(host)).length).toBe(before);
  await panel(host).getByRole('button', { name: 'Seek', exact: true }).click();
  await expect.poll(async () => (await commands(host)).length).toBe(before + 1);
  for (const p of [host, guest]) {
    await expect
      .poll(() =>
        media(p).evaluate((v: HTMLVideoElement, ms) => Math.abs(v.currentTime - ms / 1000), target),
      )
      .toBeLessThan(isPaused ? 0.25 : 1);
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(isPaused);
  }
  expect((await commands(host)).at(-1)?.type).toBe('SEEK');
}
async function privacy(host: Peer, guest: Peer) {
  for (const p of [host, guest]) {
    for (const send of await p.page.evaluate(() => window.rtcProbe.controlSends)) {
      expect(send.kind).toBe('string');
      expect(send.bytes).toBeLessThanOrEqual(MAX_PEER_MESSAGE_BYTES);
      expect(parsePeerMessage(send.text).ok).toBe(true);
      expect(send.text).not.toMatch(
        /private-playback|contentRoot|chunkDigest|blob:|video\/mp4|duration|clockOffset|positionSeconds/,
      );
    }
    for (const f of p.frames)
      expect(['PLAY', 'PAUSE', 'SEEK']).not.toContain(
        (JSON.parse(f.text) as { type: string }).type,
      );
    expect(p.requests.filter((r) => !['GET', 'HEAD'].includes(r.method))).toEqual([]);
    expect(await storageSnapshot(p.page)).toEqual(EMPTY_STORAGE);
    expect(new URL(p.page.url()).search).toBe('');
    expect(new URL(p.page.url()).hash).toBe('');
  }
  expect(await commands(guest)).toEqual([]);
}
test.afterEach(closePeers);
test('3B baseline aligns different preview positions paused with revision 1', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems, false);
  await media(host).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 2;
  });
  await media(guest).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 5;
  });
  await ready(host, guest);
  for (const peer of [host, guest]) {
    const calls = await peer.page.evaluate(() => window.rtcProbe.playbackCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userActivation).toBe(true);
    expect(calls[0]?.volume).toBe(1);
    expect(calls[0]?.muted).toBe(false);
  }
  const baseline = (await commands(host))[0];
  expect(baseline).toMatchObject({ type: 'PAUSE', payload: { revision: 1, positionMs: 2000 } });
  await expect
    .poll(() => media(guest).evaluate((v: HTMLVideoElement) => Math.abs(v.currentTime - 2)))
    .toBeLessThan(0.25);
  for (const p of [host, guest])
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
  expect(
    await panel(guest)
      .getByRole('button', { name: /^(Play|Pause|Seek)$/ })
      .count(),
  ).toBe(0);
  await privacy(host, guest);
});
test('3B repeated command sequence Play Pause Seek Play Pause', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await playing(host, guest);
  await paused(host, guest);
  await commitSeek(host, guest, 2000, true);
  await playing(host, guest);
  await paused(host, guest);
  const cmds = await commands(host);
  expect(cmds.map((c) => c.type)).toEqual(['PAUSE', 'PLAY', 'PAUSE', 'SEEK', 'PLAY', 'PAUSE']);
  expect(cmds.map((c) => c.payload.revision)).toEqual([1, 2, 3, 4, 5, 6]);
  for (const c of cmds) {
    expect(c.payload.localSelectionId).toBe(cmds[0]?.payload.localSelectionId);
    expect(c.payload.remoteSelectionId).toBe(cmds[0]?.payload.remoteSelectionId);
    expect(c.payload.localReadinessId).toBe(cmds[0]?.payload.localReadinessId);
    expect(c.payload.remoteReadinessId).toBe(cmds[0]?.payload.remoteReadinessId);
  }
  const position = cmds.at(-1)?.payload.positionMs ?? -1;
  await expect
    .poll(() =>
      media(guest).evaluate(
        (v: HTMLVideoElement, ms) => Math.abs(v.currentTime * 1000 - ms),
        position,
      ),
    )
    .toBeLessThan(250);
  await privacy(host, guest);
});
test('3B Seek while playing preserves playing authority', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await playing(host, guest);
  await commitSeek(host, guest, 4000, false);
  expect((await commands(host)).map((c) => c.type)).toEqual(['PAUSE', 'PLAY', 'SEEK']);
  await privacy(host, guest);
});
test('3B Not Ready while playing pauses both and re-ready establishes fresh baseline', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await playing(host, guest);
  const before = (await commands(host)).length;
  await panel(guest).getByRole('button', { name: 'Not ready', exact: true }).click();
  for (const p of [host, guest]) {
    await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
  }
  expect((await commands(host)).length).toBe(before);
  await panel(guest).getByRole('button', { name: "I'm ready", exact: true }).click();
  await expect(panel(guest).getByText('The host controls playback.')).toBeVisible();
  expect((await commands(host)).at(-1)).toMatchObject({ type: 'PAUSE', payload: { revision: 1 } });
  expect(await media(guest).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
test('3B replacement while playing stops authority and old pair cannot control replacement', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await playing(host, guest);
  const oldCommand = (await commands(host)).at(-1);
  await select(guest);
  await expect.poll(() => media(host).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await matching(host, guest);
  await ready(host, guest);
  const baseline = (await commands(host)).at(-1);
  expect(baseline).toMatchObject({ type: 'PAUSE', payload: { revision: 1 } });
  expect(baseline?.payload.remoteSelectionId).not.toBe(oldCommand?.payload.remoteSelectionId);
  const receivedBefore = await guest.page.evaluate(() => window.rtcProbe.received.length);
  // Use the existing real-channel probe, preserving envelope ordering but retaining stale pair.
  await host.page.evaluate((cmd) => {
    const last = JSON.parse(window.rtcProbe.controlSends.at(-1)?.text ?? '{}') as {
      sequence: number;
    };
    window.rtcProbe.channels.at(-1)?.send(
      JSON.stringify({
        ...cmd,
        sequence: last.sequence + 1,
        payload: { ...cmd?.payload, revision: 50 },
      }),
    );
  }, oldCommand);
  await expect
    .poll(() => guest.page.evaluate(() => window.rtcProbe.received.length))
    .toBe(receivedBefore + 1);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
test('3B fresh peer recovery while playing pauses resets Ready and never replays commands', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await playing(host, guest);
  const before = (await commands(host)).length;
  await breakDataChannel(guest);
  for (const p of [host, guest]) {
    await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(status(p.page)).toHaveText(CONNECTED_STATUS, { timeout: 20_000 });
    expect(await p.page.evaluate(() => window.rtcProbe.channels.length)).toBe(2);
    expect(await p.page.evaluate(() => window.rtcProbe.slices.length)).toBe(1);
    await expect(panel(p).getByText('Both participants are ready.', { exact: true })).toHaveCount(
      0,
    );
  }
  expect((await commands(host)).length).toBe(before);
  await ready(host, guest);
  expect((await commands(host)).at(-1)).toMatchObject({ type: 'PAUSE', payload: { revision: 1 } });
  for (const p of [host, guest])
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
test('3B signaling-only reconnect preserves playing channel revision and preparation', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  await playing(host, guest);
  const before = await commands(host);
  const preparationCalls = await guest.page.evaluate(() => window.rtcProbe.playbackCalls.length);
  await dropSignaling(guest);
  await expect.poll(() => identities(guest).length, { timeout: 20_000 }).toBe(2);
  await expect(status(guest.page)).toHaveText(CONNECTED_STATUS);
  for (const p of [host, guest]) {
    expect(await p.page.evaluate(() => window.rtcProbe.channels.length)).toBe(1);
    expect(await media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  }
  expect(await guest.page.evaluate(() => window.rtcProbe.playbackCalls.length)).toBe(
    preparationCalls,
  );
  expect(await commands(host)).toEqual(before);
  expect(await commands(guest)).toEqual([]);
});
test('3B rapid bounded commands keep revisions and final guest state below burst', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  for (let i = 0; i < 3; i++) {
    await playing(host, guest);
    await paused(host, guest);
    await commitSeek(host, guest, 1000 + i * 1000, true);
    await playing(host, guest);
    await paused(host, guest);
    await commitSeek(host, guest, 1500 + i * 1000, true);
  }
  const cmds = await commands(host);
  expect(cmds.length).toBe(19);
  expect(cmds.map((c) => c.payload.revision)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
  const applications = await host.page.evaluate(
    () =>
      window.rtcProbe.controlSends.filter(
        (s) =>
          !['PEER_HELLO', 'PEER_READY'].includes((JSON.parse(s.text) as { type: string }).type),
      ).length,
  );
  expect(applications).toBeLessThan(32);
  await expectConnected(host, guest);
  await privacy(host, guest);
});
test('3B forged guest PLAY fails host current channel and recovers without dispatch', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  const baseline = (await commands(host))[0];
  await guest.page.evaluate((cmd) => {
    const ready = JSON.parse(
      window.rtcProbe.controlSends.find((s) => s.text.includes('"READY"'))?.text ?? '{}',
    ) as { payload: object };
    const last = JSON.parse(window.rtcProbe.controlSends.at(-1)?.text ?? '{}') as {
      sequence: number;
    };
    window.rtcProbe.channels.at(-1)?.send(
      JSON.stringify({
        ...cmd,
        type: 'PLAY',
        sequence: last.sequence + 1,
        payload: {
          ...cmd?.payload,
          ...ready.payload,
          revision: 2,
          positionMs: 6000,
          fingerprint: undefined,
          readinessId: undefined,
        },
      }),
    );
  }, baseline);
  for (const p of [host, guest]) {
    await expect.poll(() => p.page.evaluate(() => window.rtcProbe.channels.length)).toBe(2);
    await expect(status(p.page)).toHaveText(CONNECTED_STATUS, { timeout: 20_000 });
  }
  expect(await media(host).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('3B stale Ready-cycle command with fresh peer sequence cannot control the same media', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  const old = (await commands(host))[0];
  expect(old).toBeDefined();
  await panel(guest).getByRole('button', { name: 'Not ready', exact: true }).click();
  await expect(panel(host).getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
  await media(host).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 6;
  });
  await panel(guest).getByRole('button', { name: "I'm ready", exact: true }).click();
  await expect(panel(guest).getByText('The host controls playback.')).toBeVisible();
  const fresh = (await commands(host)).at(-1);
  expect(fresh).toMatchObject({ type: 'PAUSE', payload: { revision: 1, positionMs: 6000 } });
  expect(fresh?.payload.localSelectionId).toBe(old?.payload.localSelectionId);
  expect(fresh?.payload.remoteSelectionId).toBe(old?.payload.remoteSelectionId);
  expect(fresh?.payload.localReadinessId).toBe(old?.payload.localReadinessId);
  expect(fresh?.payload.remoteReadinessId).not.toBe(old?.payload.remoteReadinessId);
  const before = await guest.page.evaluate(() => window.rtcProbe.received.length);
  // Existing test-only real-channel probe: valid current transport envelope,
  // same media, old Ready IDs, and a revision newer than Cycle B's baseline.
  await host.page.evaluate((cmd) => {
    const last = JSON.parse(window.rtcProbe.controlSends.at(-1)?.text ?? '{}') as {
      sequence: number;
    };
    window.rtcProbe.channels.at(-1)?.send(
      JSON.stringify({
        ...cmd,
        sequence: last.sequence + 1,
        payload: { ...cmd?.payload, revision: 50, positionMs: 2000 },
      }),
    );
  }, old);
  await expect
    .poll(() => guest.page.evaluate(() => window.rtcProbe.received.length))
    .toBe(before + 1);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(6, 2);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await media(guest).evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
  await expect(panel(guest).getByText('The host controls playback.')).toBeVisible();
  await expectConnected(host, guest);
  await privacy(host, guest);
});
