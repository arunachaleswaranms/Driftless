import { readFileSync } from 'node:fs';
import {
  MAX_PEER_MESSAGE_BYTES,
  MEDIA_FINGERPRINT_CHUNK_BYTES,
  parsePeerMessage,
} from '@driftless/protocol';
import { test, expect } from './support.ts';
import { PEER_APPLICATION_RATE_BURST } from '../src/features/room/peerSession.ts';
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
  statusLog,
  CONNECTED_STATUS,
  EMPTY_STORAGE,
  storageSnapshot,
  type Peer,
} from './room-support.ts';
const mp4 = readFileSync(new URL('./media/synthetic-320x180-8s-h264-aac.mp4', import.meta.url));
const webm = readFileSync(new URL('./media/synthetic-256x144-6s.webm', import.meta.url));
const setupPanel = (peer: Peer) => peer.page.getByRole('region', { name: 'Local Sync setup' });
async function select(peer: Peer, name: string, bytes = mp4) {
  await peer.page.locator('input[type=file]').setInputFiles({
    name,
    mimeType: name.endsWith('webm') ? 'video/webm' : 'video/mp4',
    buffer: bytes,
  });
  await expect(
    peer.page.getByRole('region', { name: 'Local video' }).getByRole('status'),
  ).toHaveText('Ready. Use the video controls to play, pause, and seek.');
}
async function matched(host: Peer, guest: Peer) {
  for (const peer of [host, guest]) {
    await expect(setupPanel(peer).getByText('Media matches.', { exact: true })).toBeVisible();
    await expect(
      setupPanel(peer).getByRole('button', { name: "I'm ready", exact: true }),
    ).toBeEnabled();
  }
}
async function bothReady(host: Peer, guest: Peer) {
  await matched(host, guest);
  await setupPanel(host).getByRole('button', { name: "I'm ready", exact: true }).click();
  const guestReady = setupPanel(guest).getByRole('button', { name: "I'm ready", exact: true });
  await guestReady.focus();
  await guestReady.press('Enter');
  for (const peer of [host, guest])
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toBeVisible();
}
async function privacy(peer: Peer, names: string[]) {
  const evidence = await peer.page.evaluate(() => ({
    sends: window.rtcProbe.controlSends,
    slices: window.rtcProbe.slices,
    whole: window.rtcProbe.wholeFileReads,
  }));
  expect(evidence.sends.length).toBeGreaterThan(2);
  // Normal Phase 3A setup remains well below one inbound burst, even without refill.
  const applications = evidence.sends.filter((send) => {
    const parsed = parsePeerMessage(send.text);
    return parsed.ok && !['PEER_HELLO', 'PEER_READY'].includes(parsed.message.type);
  });
  expect(applications.length).toBeLessThan(PEER_APPLICATION_RATE_BURST / 2);
  for (const send of evidence.sends) {
    expect(send.kind).toBe('string');
    expect(send.bytes).toBeLessThanOrEqual(MAX_PEER_MESSAGE_BYTES);
    expect(parsePeerMessage(send.text).ok).toBe(true);
    expect(send.text).not.toMatch(
      /contentRoot|chunkDigest|lastModified|objectUrl|video\/mp4|blob:/,
    );
    for (const name of names) expect(send.text.includes(name)).toBe(false);
  }
  expect(evidence.whole).toBe(0);
  expect(evidence.slices.length).toBeGreaterThan(0);
  for (const slice of evidence.slices)
    expect(slice.end - slice.start).toBeLessThanOrEqual(MEDIA_FINGERPRINT_CHUNK_BYTES);
  expect(peer.requests.filter((r) => !['GET', 'HEAD'].includes(r.method))).toEqual([]);
  for (const frame of peer.frames) {
    const type = (JSON.parse(frame.text) as { type: string }).type;
    expect(['MEDIA_INFO', 'MEDIA_MATCH', 'MEDIA_MISMATCH', 'READY', 'NOT_READY']).not.toContain(
      type,
    );
    for (const name of names) expect(frame.text.includes(name)).toBe(false);
    expect(frame.text.includes(mp4.toString('base64'))).toBe(false);
  }
  expect(await storageSnapshot(peer.page)).toEqual(EMPTY_STORAGE);
}
test.afterEach(closePeers);
async function connectedPair(
  browser: Parameters<typeof openPeer>[0],
  baseURL: string | undefined,
  problems: string[],
) {
  const host = await openPeer(browser, baseURL, problems);
  const guest = await openPeer(browser, baseURL, problems);
  const invite = await createRoom(host);
  await join(guest, invite.roomId, invite.inviteSecret);
  await expectConnected(host, guest);
  return { host, guest };
}
async function readyPair(
  browser: Parameters<typeof openPeer>[0],
  baseURL: string | undefined,
  problems: string[],
) {
  const pair = await connectedPair(browser, baseURL, problems);
  await select(pair.host, 'private-host-copy.mp4');
  await select(pair.guest, 'private-guest-renamed.mp4');
  await bothReady(pair.host, pair.guest);
  return pair;
}
test('Local Sync same media matches under different names, explicit ready, no transfer or playback', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await readyPair(browser, baseURL, pageProblems);
  for (const peer of [host, guest]) {
    expect(
      await peer.page
        .locator('video')
        .evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime })),
    ).toEqual({ paused: true, time: 0 });
    await privacy(peer, ['private-host-copy.mp4', 'private-guest-renamed.mp4']);
  }
  await setupPanel(host).getByRole('button', { name: 'Not ready', exact: true }).click();
  await expect(
    setupPanel(guest).getByText('Both participants are ready.', { exact: true }),
  ).toHaveCount(0);
});
test('Local Sync byte mismatch with two playable fixtures blocks Ready', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  await select(host, 'same-name.webm', webm);
  await select(
    guest,
    'same-name.webm',
    readFileSync(new URL('./media/synthetic-320x180-10s.webm', import.meta.url)),
  );
  for (const peer of [host, guest]) {
    await expect(
      setupPanel(peer).getByText('Media does not match.', { exact: true }),
    ).toBeVisible();
    await expect(
      setupPanel(peer).getByRole('button', { name: "I'm ready", exact: true }),
    ).toBeDisabled();
    await privacy(peer, ['same-name.webm']);
  }
});
test('Local Sync replacement invalidates both-ready and new matching bytes require Ready again', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await readyPair(browser, baseURL, pageProblems);
  const oldIds = await host.page.evaluate(() =>
    window.rtcProbe.controlSends
      .filter((m) => m.text.includes('"MEDIA_INFO"'))
      .map((m) => (JSON.parse(m.text) as { payload: { selectionId: string } }).payload.selectionId),
  );
  await select(host, 'different.webm', webm);
  for (const peer of [host, guest]) {
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toHaveCount(0);
    await expect(
      setupPanel(peer).getByText('Media does not match.', { exact: true }),
    ).toBeVisible();
  }
  await select(host, 'matching-again.mp4');
  await matched(host, guest);
  for (const peer of [host, guest])
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toHaveCount(0);
  const ids = await host.page.evaluate(() =>
    window.rtcProbe.controlSends
      .filter((m) => m.text.includes('"MEDIA_INFO"'))
      .map((m) => (JSON.parse(m.text) as { payload: { selectionId: string } }).payload.selectionId),
  );
  expect(new Set(ids).size).toBe(3);
  expect(ids[0]).toBe(oldIds[0]);
  await bothReady(host, guest);
});
test('Local Sync clear withdraws, releases video and sends no empty media info', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await readyPair(browser, baseURL, pageProblems);
  const count = await host.page.evaluate(() => window.rtcProbe.controlSends.length);
  await host.page.getByRole('button', { name: 'Clear video', exact: true }).click();
  await expect(host.page.locator('video')).toHaveCount(0);
  for (const peer of [host, guest])
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toHaveCount(0);
  await expect(
    setupPanel(guest).getByText('Waiting for the other participant to choose media.', {
      exact: true,
    }),
  ).toBeVisible();
  const types = await host.page.evaluate(
    (n) =>
      window.rtcProbe.controlSends
        .slice(n)
        .map((m) => (JSON.parse(m.text) as { type: string }).type),
    count,
  );
  expect(types).toEqual(['NOT_READY']);
});
test('Local Sync fresh peer recovery reannounces current media and resets both Ready choices', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await readyPair(browser, baseURL, pageProblems);
  await breakDataChannel(guest);
  for (const peer of [host, guest]) {
    await expect.poll(() => peer.page.evaluate(() => window.rtcProbe.channels.length)).toBe(2);
    await expect(status(peer.page)).toHaveText(CONNECTED_STATUS, { timeout: 20_000 });
  }
  await matched(host, guest);
  for (const peer of [host, guest]) {
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toHaveCount(0);
    const evidence = await peer.page.evaluate(() => ({
      reads: window.rtcProbe.slices.length,
      info: window.rtcProbe.controlSends.map(
        (m) =>
          JSON.parse(m.text) as {
            type: string;
            sequence: number;
            payload: { negotiationId: string };
          },
      ),
    }));
    expect(evidence.reads).toBe(1);
    const infos = evidence.info.filter((m) => m.type === 'MEDIA_INFO');
    expect(infos).toHaveLength(2);
    expect(infos[0]?.payload.negotiationId).not.toBe(infos[1]?.payload.negotiationId);
    expect(
      evidence.info
        .filter((m) => m.payload.negotiationId === infos[1]?.payload.negotiationId)
        .map((m) => m.type),
    ).not.toContain('READY');
  }
  await bothReady(host, guest);
});
test('Local Sync signaling-only reconnect preserves channel, identity and both-ready', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await readyPair(browser, baseURL, pageProblems);
  const before = await guest.page.evaluate(() => ({
    sends: window.rtcProbe.controlSends.length,
    reads: window.rtcProbe.slices.length,
  }));
  await dropSignaling(guest);
  await expect.poll(() => identities(guest).length, { timeout: 20_000 }).toBe(2);
  await expect(status(guest.page)).toHaveText(CONNECTED_STATUS);
  for (const peer of [host, guest]) {
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toBeVisible();
    expect(await peer.page.evaluate(() => window.rtcProbe.channels.length)).toBe(1);
  }
  expect(
    await guest.page.evaluate(() => ({
      sends: window.rtcProbe.controlSends.length,
      reads: window.rtcProbe.slices.length,
    })),
  ).toEqual(before);
});

test('Local Sync valid application flooding closes the receiver session and recovers with Ready reset', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await readyPair(browser, baseURL, pageProblems);
  // The existing E2E probe holds the real channel. No production hook is needed.
  // Exact admission timing is asserted by injected-clock PeerSession unit tests.
  const injected = await guest.page.evaluate((burst) => {
    const probe = window.rtcProbe;
    const channel = probe.channels.at(-1);
    const lastText = probe.controlSends.at(-1)?.text;
    const readyText = probe.controlSends.find(
      (m) => (JSON.parse(m.text) as { type: string }).type === 'READY',
    )?.text;
    if (!channel || !lastText || !readyText) throw new Error('no ready control channel');
    const last = JSON.parse(lastText) as { sequence: number };
    const ready = JSON.parse(readyText) as { sequence: number; sentAt: number };
    const texts: string[] = [];
    for (let i = 0; i <= burst; i++) {
      const text = JSON.stringify({ ...ready, sequence: last.sequence + 1 + i, sentAt: 0 });
      texts.push(text);
      channel.send(text);
    }
    return texts;
  }, PEER_APPLICATION_RATE_BURST);
  expect(injected).toHaveLength(PEER_APPLICATION_RATE_BURST + 1);
  for (const text of injected) expect(parsePeerMessage(text).ok).toBe(true);
  await expect
    .poll(() =>
      host.page.evaluate(() => ({
        channel: window.rtcProbe.channels[0]?.readyState,
        connection: window.rtcProbe.peerConnections[0]?.connectionState,
      })),
    )
    .toEqual({ channel: 'closed', connection: 'closed' });
  for (const peer of [host, guest]) {
    await expect.poll(() => peer.page.evaluate(() => window.rtcProbe.channels.length)).toBe(2);
    await expect(status(peer.page)).toHaveText(CONNECTED_STATUS, { timeout: 20_000 });
    expect(await statusLog(peer)).toContain('Peer connection lost. Recovering…');
    await expect(
      setupPanel(peer).getByText('Both participants are ready.', { exact: true }),
    ).toHaveCount(0);
    const evidence = await peer.page.evaluate(() => ({
      reads: window.rtcProbe.slices.length,
      infos: window.rtcProbe.controlSends
        .map(
          (m) =>
            JSON.parse(m.text) as {
              type: string;
              payload: { negotiationId: string; fingerprint: string; selectionId: string };
            },
        )
        .filter((m) => m.type === 'MEDIA_INFO'),
    }));
    expect(evidence.reads).toBe(1);
    expect(evidence.infos).toHaveLength(2);
    expect(evidence.infos[1]?.payload.negotiationId).not.toBe(
      evidence.infos[0]?.payload.negotiationId,
    );
    expect(evidence.infos[1]?.payload.fingerprint).toBe(evidence.infos[0]?.payload.fingerprint);
    expect(evidence.infos[1]?.payload.selectionId).toBe(evidence.infos[0]?.payload.selectionId);
  }
  await bothReady(host, guest);
});
