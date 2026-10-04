import type { Page } from '@playwright/test';
import {
  CONNECTED,
  EMPTY_STORAGE,
  SDP_OR_ICE,
  WAITING,
  closePeers,
  createRoom,
  expectConnected,
  invite,
  inviteValue,
  join,
  openPeer,
  room,
  rtcState,
  status,
  storageSnapshot,
} from './room-support.ts';
import { expect, test } from './support.ts';

// AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE. Every peer here is a
// separate browser context in one browser on one machine, talking to a local
// signaling service through the preview server's same-origin proxy, with real
// RTCPeerConnection and RTCDataChannel objects and no ICE server. This is not
// real-network, NAT-traversal, TURN, Android, or compatibility evidence.

// Each test drives several browser contexts with live peer connections, so
// the tests in this file run one at a time rather than in parallel with each
// other, and get a longer bound than the default.
test.describe.configure({ mode: 'default', timeout: 90_000 });

test.afterEach(async () => {
  await closePeers();
});

test('connects a host and a guest over a real data channel and proves traffic both ways', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const host = await openPeer(browser, baseURL, pageProblems);
  const guest = await openPeer(browser, baseURL, pageProblems);
  expect(await storageSnapshot(host.page)).toEqual(EMPTY_STORAGE);
  expect(await storageSnapshot(guest.page)).toEqual(EMPTY_STORAGE);
  // Nothing connects before the user acts.
  expect(host.sockets).toEqual([]);
  expect((await rtcState(host.page)).peerConnections).toEqual([]);

  const { roomId, inviteSecret } = await createRoom(host);
  await join(guest, roomId, inviteSecret);
  await expectConnected(host, guest);

  const hostRtc = await rtcState(host.page);
  const guestRtc = await rtcState(guest.page);
  // One peer connection per side, connected, with no media of any kind.
  for (const rtc of [hostRtc, guestRtc]) {
    expect(rtc.peerConnections).toEqual([
      {
        connectionState: 'connected',
        iceConnectionState: expect.stringMatching(/^(connected|completed)$/) as unknown,
        signalingState: 'stable',
        senders: 0,
        receivers: 0,
        transceivers: 0,
      },
    ]);
    // Exactly one channel: the host's ordered, reliable control channel.
    expect(rtc.channels).toEqual([
      {
        label: 'driftless-control',
        ordered: true,
        maxRetransmits: null,
        maxPacketLifeTime: null,
        protocol: '',
        negotiated: false,
        readyState: 'open',
      },
    ]);
    expect(rtc.mediaCalls).toEqual([]);
    // The same-origin WebSocket needed no CSP change.
    expect(rtc.cspViolations).toEqual([]);
  }

  // The handshake crossed the channel in both directions, for one negotiation.
  const [negotiationId] = hostRtc.sent.map((message) => message.negotiationId);
  expect(negotiationId).toMatch(/^[A-Za-z0-9_-]{24}$/);
  // And for one room session, which both peers learned from signaling.
  const [sessionId] = hostRtc.sent.map((message) => message.sessionId);
  expect(sessionId).toMatch(/^[A-Za-z0-9_-]{27}$/);
  for (const rtc of [hostRtc, guestRtc]) {
    expect(rtc.sent.map((message) => message.type).sort()).toEqual(['PEER_HELLO', 'PEER_READY']);
    expect(rtc.received.map((message) => message.type).sort()).toEqual([
      'PEER_HELLO',
      'PEER_READY',
    ]);
    for (const message of [...rtc.sent, ...rtc.received]) {
      expect(message.negotiationId).toBe(negotiationId);
      expect(message.sessionId).toBe(sessionId);
    }
  }

  // The interface states what is connected, and nothing more.
  for (const peer of [host, guest]) {
    const text = await room(peer.page).innerText();
    expect(text).toContain('synchronized playback is not available');
    expect(text).not.toMatch(SDP_OR_ICE);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toMatch(/synchronized playback is ready|Progressive Watch/i);
    await expect(
      room(peer.page).getByRole('button', { name: "I'm ready", exact: true }),
    ).toBeDisabled();
  }
  await expect(room(host.page).locator('dt', { hasText: 'Your role' }).locator('+ dd')).toHaveText(
    'Host',
  );
  await expect(room(guest.page).locator('dt', { hasText: 'Your role' }).locator('+ dd')).toHaveText(
    'Guest',
  );

  // One same-origin signaling socket per peer, with nothing in its URL.
  const origin = new URL(baseURL ?? '');
  for (const peer of [host, guest]) {
    expect(peer.sockets.map((socket) => socket.url())).toEqual([
      `ws://${origin.host}/v1/signaling`,
    ]);
    for (const { method, url } of peer.requests) {
      const parsed = new URL(url);
      expect(method, url).toBe('GET');
      expect(parsed.origin, url).toBe(origin.origin);
      expect(parsed.search, url).toBe('');
      expect(parsed.pathname, url).toMatch(
        /^\/($|assets\/|icons\/|manifest\.webmanifest$|sw\.js$)/,
      );
      expect(url).not.toContain(inviteSecret);
      expect(url).not.toContain(roomId);
    }
    // The room never reached the address bar or history: one navigation, to the root.
    expect(peer.navigations).toEqual([`${origin.origin}/`]);
    expect(await storageSnapshot(peer.page)).toEqual(EMPTY_STORAGE);
  }

  // Leave cleanly from both sides; everything is released.
  await room(guest.page).getByRole('button', { name: 'Leave room' }).click();
  await expect(status(guest.page)).toHaveText('You left the room. You are not in a room.');
  await room(host.page).getByRole('button', { name: 'Leave room' }).click();
  await expect(status(host.page)).toHaveText('You left the room. You are not in a room.');
  for (const peer of [host, guest]) {
    const rtc = await rtcState(peer.page);
    expect(rtc.peerConnections.map((connection) => connection.connectionState)).toEqual(['closed']);
    expect(rtc.channels.map((channel) => channel.readyState)).toEqual(['closed']);
    expect(await storageSnapshot(peer.page)).toEqual(EMPTY_STORAGE);
    // The invite is gone from the page once the room is left.
    expect(await peer.page.content()).not.toContain(inviteSecret);
  }
});

test('refuses a wrong invite secret without revealing the room or creating a peer connection', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const host = await openPeer(browser, baseURL, pageProblems);
  const guest = await openPeer(browser, baseURL, pageProblems);
  const { roomId, inviteSecret } = await createRoom(host);
  const wrong = `${inviteSecret.slice(0, 10)}${inviteSecret[10] === 'A' ? 'B' : 'A'}${inviteSecret.slice(11)}`;

  await join(guest, roomId, wrong);
  const alert = room(guest.page).getByRole('alert');
  await expect(alert).toHaveText(
    'That room is not available. Check the room ID and invite secret, or ask the host for a new invite.',
  );
  await expect(status(guest.page)).toHaveText('Not in a room.');
  // The same answer as for a room that does not exist.
  await join(
    guest,
    `${roomId.slice(0, 5)}${roomId[5] === 'A' ? 'B' : 'A'}${roomId.slice(6)}`,
    inviteSecret,
  );
  await expect(alert).toHaveText(
    'That room is not available. Check the room ID and invite secret, or ask the host for a new invite.',
  );
  // The secret field is cleared after each attempt.
  await expect(room(guest.page).getByLabel('Invite secret')).toHaveValue('');
  expect((await rtcState(guest.page)).peerConnections).toEqual([]);
  // The host saw nothing.
  await expect(status(host.page)).toHaveText(WAITING);
  expect((await rtcState(host.page)).peerConnections).toEqual([]);

  // Malformed details are refused before any request is made.
  const socketsBefore = guest.sockets.length;
  await join(guest, 'not-a-room', 'not-a-secret');
  await expect(alert).toHaveText(
    'Enter the room ID and invite secret exactly as the host shared them.',
  );
  expect(guest.sockets).toHaveLength(socketsBefore);
});

test('refuses a third participant and keeps the existing pair connected', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const host = await openPeer(browser, baseURL, pageProblems);
  const guest = await openPeer(browser, baseURL, pageProblems);
  const third = await openPeer(browser, baseURL, pageProblems);
  const { roomId, inviteSecret } = await createRoom(host);
  await join(guest, roomId, inviteSecret);
  await expectConnected(host, guest);

  await join(third, roomId, inviteSecret);
  await expect(room(third.page).getByRole('alert')).toHaveText(
    'That room already has two participants.',
  );
  expect((await rtcState(third.page)).peerConnections).toEqual([]);

  // The pair is undisturbed.
  await expect(status(host.page)).toHaveText(CONNECTED);
  await expect(status(guest.page)).toHaveText(CONNECTED);
  for (const peer of [host, guest]) {
    const rtc = await rtcState(peer.page);
    expect(rtc.peerConnections.map((connection) => connection.connectionState)).toEqual([
      'connected',
    ]);
    expect(rtc.channels.map((channel) => channel.readyState)).toEqual(['open']);
  }
});

test('returns the host to waiting when the guest leaves, then connects a new guest afresh', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const host = await openPeer(browser, baseURL, pageProblems);
  const guest = await openPeer(browser, baseURL, pageProblems);
  const { roomId, inviteSecret } = await createRoom(host);
  await join(guest, roomId, inviteSecret);
  await expectConnected(host, guest);
  const firstNegotiation = (await rtcState(host.page)).sent[0]?.negotiationId;

  await room(guest.page).getByRole('button', { name: 'Leave room' }).click();
  await expect(status(guest.page)).toHaveText('You left the room. You are not in a room.');
  await expect(status(host.page)).toHaveText(`The guest left. ${WAITING}`);
  for (const peer of [host, guest]) {
    const rtc = await rtcState(peer.page);
    expect(rtc.peerConnections.map((connection) => connection.connectionState)).toEqual(['closed']);
    expect(rtc.channels.map((channel) => channel.readyState)).toEqual(['closed']);
  }
  // No reconnect is attempted: after a while, nothing new has been created.
  await host.page.waitForTimeout(1000);
  expect((await rtcState(host.page)).peerConnections).toHaveLength(1);
  expect((await rtcState(guest.page)).peerConnections).toHaveLength(1);
  await expect(status(host.page)).toHaveText(`The guest left. ${WAITING}`);

  // A new guest is a new join with a new negotiation and peer connection.
  const next = await openPeer(browser, baseURL, pageProblems);
  await join(next, roomId, inviteSecret);
  await expectConnected(host, next);
  const hostRtc = await rtcState(host.page);
  expect(hostRtc.peerConnections.map((connection) => connection.connectionState)).toEqual([
    'closed',
    'connected',
  ]);
  const secondNegotiation = hostRtc.sent.at(-1)?.negotiationId;
  expect(secondNegotiation).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(secondNegotiation).not.toBe(firstNegotiation);
  const nextRtc = await rtcState(next.page);
  expect(nextRtc.received.every((message) => message.negotiationId === secondNegotiation)).toBe(
    true,
  );
  // The departed guest received nothing further.
  expect((await rtcState(guest.page)).received).toHaveLength(2);
});

test('closes the room for the guest when the host leaves and invalidates the invite', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const host = await openPeer(browser, baseURL, pageProblems);
  const guest = await openPeer(browser, baseURL, pageProblems);
  const { roomId, inviteSecret } = await createRoom(host);
  await join(guest, roomId, inviteSecret);
  await expectConnected(host, guest);

  await room(host.page).getByRole('button', { name: 'Leave room' }).click();
  await expect(status(host.page)).toHaveText('You left the room. You are not in a room.');
  await expect(status(guest.page)).toHaveText('The host closed the room. You are not in a room.');
  // The guest is not promoted: it is out of the room, with its peer closed.
  await expect(room(guest.page).getByRole('button', { name: 'Create room' })).toBeVisible();
  for (const peer of [host, guest]) {
    const rtc = await rtcState(peer.page);
    expect(rtc.peerConnections.map((connection) => connection.connectionState)).toEqual(['closed']);
    expect(rtc.channels.map((channel) => channel.readyState)).toEqual(['closed']);
  }

  const late = await openPeer(browser, baseURL, pageProblems);
  await join(late, roomId, inviteSecret);
  await expect(room(late.page).getByRole('alert')).toHaveText(
    'That room is not available. Check the room ID and invite secret, or ask the host for a new invite.',
  );
  expect((await rtcState(late.page)).peerConnections).toEqual([]);
});

test('copies the invite on request and keeps the reveal control accessible', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const host = await openPeer(browser, baseURL, pageProblems);
  await host.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await createRoom(host);
  const secret = inviteValue(host.page, 'Invite secret');

  await invite(host.page).getByRole('button', { name: 'Copy invite secret' }).click();
  await expect(invite(host.page).getByText('Copied the invite secret.')).toBeVisible();
  const copied = await host.page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // Copying did not reveal it.
  await expect(secret).toHaveText(/^•+Hidden$/);

  // The reveal toggle works from the keyboard with a visible focus outline.
  const reveal = invite(host.page).getByRole('button', { name: 'Show invite secret' });
  await invite(host.page).getByRole('button', { name: 'Copy invite secret' }).focus();
  await host.page.keyboard.press('Shift+Tab');
  await expect(reveal).toBeFocused();
  expect(await reveal.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );
  await host.page.keyboard.press('Enter');
  await expect(reveal).toHaveAttribute('aria-pressed', 'true');
  await expect(secret).toHaveText(copied);
  await host.page.keyboard.press('Space');
  await expect(reveal).toHaveAttribute('aria-pressed', 'false');

  await invite(host.page).getByRole('button', { name: 'Copy room ID' }).click();
  await expect(invite(host.page).getByText('Copied the room ID.')).toBeVisible();
  expect(await host.page.evaluate(() => navigator.clipboard.readText())).toBe(
    await inviteValue(host.page, 'Room ID').textContent(),
  );
});

for (const viewport of [
  { width: 360, height: 740 },
  { width: 1280, height: 800 },
]) {
  test(`fits the room entry and invite at ${String(viewport.width)} px`, async ({
    browser,
    baseURL,
    pageProblems,
  }) => {
    const host = await openPeer(browser, baseURL, pageProblems);
    const guest = await openPeer(browser, baseURL, pageProblems);
    await host.page.setViewportSize(viewport);
    await guest.page.setViewportSize(viewport);
    const overflow = (page: Page) =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

    for (const control of [
      room(guest.page).getByLabel('Room ID'),
      room(guest.page).getByLabel('Invite secret'),
      room(guest.page).getByRole('button', { name: 'Join room' }),
      room(guest.page).getByRole('button', { name: 'Create room' }),
    ]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(await overflow(guest.page)).toBe(0);

    const { roomId, inviteSecret } = await createRoom(host);
    await invite(host.page).getByRole('button', { name: 'Show invite secret' }).click();
    for (const control of [
      inviteValue(host.page, 'Room ID'),
      inviteValue(host.page, 'Invite secret'),
      invite(host.page).getByRole('button', { name: 'Copy room ID' }),
      invite(host.page).getByRole('button', { name: 'Show invite secret' }),
      invite(host.page).getByRole('button', { name: 'Copy invite secret' }),
      room(host.page).getByRole('button', { name: 'Leave room' }),
    ]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(await overflow(host.page)).toBe(0);

    await join(guest, roomId, inviteSecret);
    await expectConnected(host, guest);
    expect(await overflow(host.page)).toBe(0);
    expect(await overflow(guest.page)).toBe(0);
  });
}
