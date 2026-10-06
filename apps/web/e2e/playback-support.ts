import { readFileSync } from 'node:fs';
import type { PeerMessage, PlaybackMessage } from '@driftless/protocol';
import { parsePeerMessage, MAX_PEER_MESSAGE_BYTES } from '@driftless/protocol';
import { expect } from './support.ts';
import {
  openPeer,
  createRoom,
  join,
  expectConnected,
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
        /private-playback|contentRoot|chunkDigest|blob:|video\/mp4|duration|positionSeconds/,
      );
    }
    for (const f of p.frames)
      expect(['PLAY', 'PAUSE', 'SEEK', 'SYNC']).not.toContain(
        (JSON.parse(f.text) as { type: string }).type,
      );
    expect(p.requests.filter((r) => !['GET', 'HEAD'].includes(r.method))).toEqual([]);
    expect(await storageSnapshot(p.page)).toEqual(EMPTY_STORAGE);
    expect(new URL(p.page.url()).search).toBe('');
    expect(new URL(p.page.url()).hash).toBe('');
  }
  expect(await commands(guest)).toEqual([]);
}

export {
  panel,
  media,
  select,
  matching,
  ready,
  pair,
  commands,
  playing,
  paused,
  commitSeek,
  privacy,
};

// A test-only extra frame uses fresh transport ordering. Shift later native
// sends once so the production sender's unchanged sequence cannot collide.
export async function injectPeerMessage(host: Peer, old: PeerMessage) {
  await host.page.evaluate((message) => {
    const channel = window.rtcProbe.channels.at(-1);
    if (!channel) throw new Error('no channel');
    const original = channel.send.bind(channel);
    const last = JSON.parse(window.rtcProbe.controlSends.at(-1)?.text ?? '{}') as {
      sequence: number;
    };
    original(JSON.stringify({ ...message, sequence: last.sequence + 1 }));
    channel.send = (data: string | Blob | ArrayBuffer | ArrayBufferView) => {
      if (typeof data === 'string') {
        const wire = JSON.parse(data) as { sequence: number };
        wire.sequence++;
        original(JSON.stringify(wire));
      } else Reflect.apply(original, channel, [data]);
    };
  }, old);
}
