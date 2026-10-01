import type { Browser } from '@playwright/test';
import {
  ADDRESS_LIKE,
  CONNECTED_STATUS,
  SDP_OR_ICE,
  breakDataChannel,
  closePeers,
  createRoom,
  diagnosticsFact,
  expectConnected,
  frameTypes,
  join,
  openDiagnostics,
  openPeer,
  room,
  rtcState,
  selectedPairTypes,
  status,
  type Peer,
} from './room-support.ts';
import { expect, test } from './support.ts';

// AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE for Phase 2D connection
// diagnostics: two browser contexts in one browser on one machine, a local
// signaling service with no STUN or TURN configured, and real
// RTCPeerConnection objects. The selected path here is a same-host pair; this
// is not real-network, NAT-traversal, TURN, or device evidence.

test.describe.configure({ mode: 'default', timeout: 90_000 });

test.afterEach(async () => {
  await closePeers();
});

async function connectedPair(browser: Browser, baseURL: string | undefined, problems: string[]) {
  const host = await openPeer(browser, baseURL, problems);
  const guest = await openPeer(browser, baseURL, problems);
  const { roomId, inviteSecret } = await createRoom(host);
  await join(guest, roomId, inviteSecret);
  await expectConnected(host, guest);
  return { host, guest, roomId, inviteSecret };
}

function statsCalls(peer: Peer): Promise<number[]> {
  return peer.page.evaluate(() => [...window.rtcProbe.statsCalls]);
}

test('reports the selected path from the browser’s own statistics, once, without addresses', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest, roomId, inviteSecret } = await connectedPair(browser, baseURL, pageProblems);

  for (const peer of [host, guest]) {
    const section = await openDiagnostics(peer.page);
    await expect(section).toContainText('Statistics read from this browser.');
    const truth = await selectedPairTypes(peer.page);
    expect(truth.transports).toBe(1);
    expect(truth.pairState).toBe('succeeded');
    // Same host, no TURN server: whatever pair won, it is not relayed.
    expect(truth.local).not.toBe('relay');
    expect(truth.remote).not.toBe('relay');
    await expect(diagnosticsFact(section, 'Path')).toHaveText('Direct (not relayed)');
    await expect(diagnosticsFact(section, 'Local candidate type')).toHaveText(String(truth.local));
    await expect(diagnosticsFact(section, 'Remote candidate type')).toHaveText(
      String(truth.remote),
    );
    await expect(diagnosticsFact(section, 'Transport')).toHaveText(
      String(truth.protocol).toUpperCase(),
    );
    await expect(diagnosticsFact(section, 'Peer connection')).toHaveText('connected');
    await expect(diagnosticsFact(section, 'ICE connection')).toHaveText(/^(connected|completed)$/);
    await expect(diagnosticsFact(section, 'Data channel')).toHaveText('open');
    await expect(diagnosticsFact(section, 'Signaling')).toHaveText('Connected');
    await expect(diagnosticsFact(section, 'Negotiation')).toHaveText('1 of 4');
    // The service answered the configuration request, with no TURN server.
    await expect(diagnosticsFact(section, 'TURN configuration')).toHaveText('Not configured');
    await expect(diagnosticsFact(section, 'ICE transport policy')).toHaveText('All');

    const text = await section.innerText();
    expect(text).not.toMatch(SDP_OR_ICE);
    expect(text).not.toMatch(ADDRESS_LIKE);
    expect(text).not.toContain(roomId);
    expect(text).not.toContain(inviteSecret);
  }

  // One read per side, when the session connected; nothing polls.
  expect(await statsCalls(host)).toStrictEqual([1]);
  expect(await statsCalls(guest)).toStrictEqual([1]);
  await host.page.waitForTimeout(3000);
  expect(await statsCalls(host)).toStrictEqual([1]);
  expect(await statsCalls(guest)).toStrictEqual([1]);

  // Refresh reads once more, on request.
  const section = await openDiagnostics(host.page);
  await section.getByRole('button', { name: 'Refresh diagnostics' }).click();
  await expect.poll(() => statsCalls(host)).toStrictEqual([2]);
  await expect(diagnosticsFact(section, 'Path')).toHaveText('Direct (not relayed)');

  // Each peer asked for its ICE configuration once, after admission; the
  // diagnostics never travel over signaling.
  for (const peer of [host, guest]) {
    const sent = frameTypes(peer, 0, 'sent');
    expect(sent.filter((type) => type === 'RTC_CONFIG_REQUEST')).toHaveLength(1);
    const admission = sent.indexOf(sent.includes('ROOM_CREATE') ? 'ROOM_CREATE' : 'ROOM_JOIN');
    expect(sent.indexOf('RTC_CONFIG_REQUEST')).toBeGreaterThan(admission);
    expect(frameTypes(peer, 0, 'received')).toContain('RTC_CONFIG');
    for (const frame of peer.frames.filter((entry) => entry.direction === 'sent')) {
      expect(frame.text).not.toMatch(/candidateType|DIRECT|TURN_RELAY|srflx|prflx/);
    }
  }
});

test('copies a summary of safe fields only', async ({ browser, baseURL, pageProblems }) => {
  const { host, roomId, inviteSecret } = await connectedPair(browser, baseURL, pageProblems);
  await host.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const section = await openDiagnostics(host.page);
  await expect(section).toContainText('Statistics read from this browser.');
  await section.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(section).toContainText('Copied the diagnostics.');
  const copied = await host.page.evaluate(() => navigator.clipboard.readText());
  const lines = copied.trimEnd().split('\n');
  expect(lines[0]).toBe('Driftless connection diagnostics');
  expect(lines.map((line) => line.split(': ')[0])).toStrictEqual([
    'Driftless connection diagnostics',
    'Build',
    'Collected',
    'Role',
    'Signaling',
    'Peer connection',
    'ICE connection',
    'Data channel',
    'Path',
    'Local candidate type',
    'Remote candidate type',
    'Transport',
    'Negotiation',
    'TURN configuration',
    'ICE transport policy',
  ]);
  expect(lines).toContain('Path: DIRECT');
  expect(lines).toContain('Role: host');
  expect(lines).toContain('Negotiation: 1 of 4');
  // The collection time is the only line with digits and colons.
  const withoutTime = lines.filter((line) => !line.startsWith('Collected: ')).join('\n');
  expect(withoutTime).not.toMatch(ADDRESS_LIKE);
  expect(copied).not.toMatch(SDP_OR_ICE);
  for (const value of [roomId, inviteSecret]) expect(copied).not.toContain(value);
});

test('describes the new connection after peer recovery, not the old one', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  for (const peer of [host, guest]) {
    const section = await openDiagnostics(peer.page);
    await expect(diagnosticsFact(section, 'Negotiation')).toHaveText('1 of 4');
  }

  await breakDataChannel(guest);
  await expect.poll(async () => (await rtcState(host.page)).peerConnections.length).toBe(2);
  for (const peer of [host, guest]) {
    await expect(status(peer.page)).toHaveText(CONNECTED_STATUS, { timeout: 20_000 });
    const section = await openDiagnostics(peer.page);
    await expect(diagnosticsFact(section, 'Negotiation')).toHaveText('2 of 4');
    await expect(section).toContainText('Statistics read from this browser.');
    await expect(diagnosticsFact(section, 'Path')).toHaveText('Direct (not relayed)');
    await expect(diagnosticsFact(section, 'Data channel')).toHaveText('open');
    // The new connection was read; the old one only once, before it failed.
    const calls = await statsCalls(peer);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(1);
    expect(calls[1]).toBeGreaterThanOrEqual(1);
    const truth = await selectedPairTypes(peer.page);
    await expect(diagnosticsFact(section, 'Local candidate type')).toHaveText(String(truth.local));
  }
});

test('reports an unknown path, and keeps the room, when statistics fail', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  await host.page.evaluate(() => {
    const connection = window.rtcProbe.peerConnections.at(-1);
    if (connection === undefined) throw new Error('no peer connection');
    // Shadows the method on this one object: every read now fails.
    Object.defineProperty(connection, 'getStats', {
      value: () => Promise.reject(new Error('statistics unavailable')),
    });
  });
  const section = await openDiagnostics(host.page);
  await section.getByRole('button', { name: 'Refresh diagnostics' }).click();
  await expect(diagnosticsFact(section, 'Path')).toHaveText('Unknown');
  await expect(diagnosticsFact(section, 'Path detail')).toHaveText(
    'The browser reported no usable connection statistics.',
  );
  // Observational only: the session, the channel, and signaling are untouched.
  await host.page.waitForTimeout(1500);
  await expectConnected(host, guest);
  for (const peer of [host, guest]) {
    const rtc = await rtcState(peer.page);
    expect(rtc.peerConnections).toHaveLength(1);
    expect(rtc.channels.map((channel) => channel.readyState)).toStrictEqual(['open']);
    expect(frameTypes(peer, 0, 'sent')).not.toContain('RTC_RECOVERY_REQUEST');
    expect(frameTypes(peer, 0, 'sent')).not.toContain('RTC_RECOVER');
  }
  await expect(room(host.page).getByRole('alert')).toHaveCount(0);
});
