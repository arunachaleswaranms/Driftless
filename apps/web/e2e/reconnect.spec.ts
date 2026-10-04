import type { Page } from '@playwright/test';
import {
  CONNECTED_STATUS,
  CONNECT_TIMEOUT_MS,
  EMPTY_STORAGE,
  OFFLINE_SOCKET_ERROR,
  WAITING,
  breakDataChannel,
  closePeers,
  createRoom,
  dropSignaling,
  expectConnected,
  frameTypes,
  framesContain,
  identities,
  join,
  openPeer,
  resumeSecretOf,
  room,
  rtcState,
  status,
  statusLog,
  storageSnapshot,
  type Peer,
} from './room-support.ts';
import { expect, test } from './support.ts';

// AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE of Phase 2C recovery. Every
// peer is a separate browser context in one browser on one machine, with a
// real local signaling service behind the preview server's same-origin
// proxy, real WebSockets, and real RTCPeerConnection and RTCDataChannel
// objects with no ICE server. A "lost" signaling connection is the
// application's real socket closed from the page; a network outage is
// Chromium's offline emulation, which blocks new sockets but, as observed
// here, leaves an open data channel working. This is not real-network,
// NAT-traversal, TURN, mobile, Android, or compatibility evidence.

test.describe.configure({ mode: 'default', timeout: 120_000 });

test.afterEach(async () => {
  await closePeers();
});

const SIGNALING_RECONNECTING = 'Peer data channel connected. Signaling is reconnecting…';
const PEER_RECONNECTING = 'Peer data channel connected. The other participant is reconnecting…';
const RECOVERING = 'Peer connection lost. Recovering…';

async function connectedPair(
  browser: Parameters<typeof openPeer>[0],
  baseURL: string | undefined,
  problems: string[],
) {
  const host = await openPeer(browser, baseURL, problems);
  const guest = await openPeer(browser, baseURL, problems);
  const { roomId, inviteSecret } = await createRoom(host);
  await join(guest, roomId, inviteSecret);
  await expectConnected(host, guest);
  return { host, guest, roomId, inviteSecret };
}

async function expectStatus(peer: Peer, text: string | RegExp): Promise<void> {
  await expect(status(peer.page)).toHaveText(text, { timeout: CONNECT_TIMEOUT_MS });
}

/** Waits until the peer has resumed `count` times in all. */
async function expectResumed(peer: Peer, count: number): Promise<void> {
  await expect
    .poll(() => identities(peer).filter((entry) => entry.type === 'SESSION_RESUMED').length, {
      timeout: CONNECT_TIMEOUT_MS,
    })
    .toBe(count);
}

/** Every admission and resume named the same session, participant, and role. */
function expectOneIdentity(peer: Peer, role: 'host' | 'guest', resumes: number): void {
  const all = identities(peer);
  expect(all.map((entry) => entry.type)).toStrictEqual([
    role === 'host' ? 'ROOM_CREATED' : 'ROOM_JOINED',
    ...Array.from({ length: resumes }, () => 'SESSION_RESUMED'),
  ]);
  const [first] = all;
  expect(first?.sessionId).toMatch(/^[A-Za-z0-9_-]{27}$/);
  expect(first?.participantId).toMatch(/^[A-Za-z0-9_-]{16}$/);
  for (const entry of all) {
    expect(entry.sessionId).toBe(first?.sessionId);
    expect(entry.participantId).toBe(first?.participantId);
    expect(entry.role).toBe(role);
  }
}

/** Each socket after the first resumed by BEGIN → CHALLENGE → PROVE → RESUMED, without the secret. */
function expectAuthenticatedResumes(peer: Peer, other: Peer): void {
  const secret = resumeSecretOf(peer);
  // The secret was sent once, by the service, and never again by anyone.
  expect(framesContain(peer, secret)).toBe(false);
  expect(framesContain(other, secret, 0)).toBe(false);
  const resumed = peer.sockets
    .map((_, index) => index)
    .filter((index) => frameTypes(peer, index, 'received').includes('SESSION_RESUMED'));
  expect(resumed.length).toBeGreaterThan(0);
  for (const index of resumed) {
    expect(frameTypes(peer, index, 'sent').slice(0, 2)).toStrictEqual([
      'SESSION_RESUME_BEGIN',
      'SESSION_RESUME_PROVE',
    ]);
    expect(frameTypes(peer, index, 'received').slice(0, 2)).toStrictEqual([
      'SESSION_RESUME_CHALLENGE',
      'SESSION_RESUMED',
    ]);
  }
}

/** One live data channel and peer connection, with no media of any kind. */
async function expectSingleSession(page: Page, peerConnections: number) {
  const rtc = await rtcState(page);
  expect(rtc.peerConnections).toHaveLength(peerConnections);
  expect(rtc.peerConnections.at(-1)?.connectionState).toBe('connected');
  expect(rtc.channels).toHaveLength(peerConnections);
  expect(rtc.channels.at(-1)?.readyState).toBe('open');
  for (const connection of rtc.peerConnections) {
    expect([connection.senders, connection.receivers, connection.transceivers]).toStrictEqual([
      0, 0, 0,
    ]);
  }
  expect(rtc.mediaCalls).toStrictEqual([]);
  expect(rtc.cspViolations).toStrictEqual([]);
  return rtc;
}

/** Only the previous sockets are closed: one socket is live. */
function expectOneLiveSocket(peer: Peer): void {
  expect(peer.sockets.at(-1)?.isClosed()).toBe(false);
  expect(peer.sockets.slice(0, -1).every((socket) => socket.isClosed())).toBe(true);
}

/** Removes the expected offline-socket errors, which only these tests cause, and returns their count. */
function acceptOfflineErrors(problems: string[]): number {
  const unexpected = problems.filter((problem) => !OFFLINE_SOCKET_ERROR.test(problem));
  const accepted = problems.length - unexpected.length;
  problems.splice(0, problems.length, ...unexpected);
  return accepted;
}

test('resumes a lost guest signaling connection while the data channel stays open', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  const before = await rtcState(guest.page);

  // A brief network interruption: the guest's socket is lost, and new ones
  // cannot be opened until the network returns.
  await guest.context.setOffline(true);
  await dropSignaling(guest);
  await expectStatus(guest, SIGNALING_RECONNECTING);
  await expectStatus(host, PEER_RECONNECTING);
  // The peer connection and channel are untouched while signaling is down.
  await expectSingleSession(guest.page, 1);
  await expectSingleSession(host.page, 1);
  await expect
    .poll(() => pageProblems.filter((p) => OFFLINE_SOCKET_ERROR.test(p)).length)
    .toBeGreaterThan(0);
  await expect(room(guest.page).getByRole('button', { name: 'Leave room' })).toBeEnabled();

  await guest.context.setOffline(false);
  await expectStatus(guest, CONNECTED_STATUS);
  await expectStatus(host, CONNECTED_STATUS);
  await expectResumed(guest, 1);
  expect(await statusLog(guest)).toContain('Connection restored. Peer data channel is connected.');

  expectOneIdentity(guest, 'guest', 1);
  expectOneIdentity(host, 'host', 0);
  expectAuthenticatedResumes(guest, host);
  // The same RTCDataChannel, still open; no new peer connection or negotiation.
  const after = await expectSingleSession(guest.page, 1);
  expect(after.sent).toStrictEqual(before.sent);
  expect(after.received).toStrictEqual(before.received);
  await expectSingleSession(host.page, 1);
  expectOneLiveSocket(guest);
  expect(frameTypes(host, 0, 'received')).toContain('ROOM_PARTICIPANT_CONNECTION');
  for (const peer of [host, guest]) {
    expect(await storageSnapshot(peer.page)).toEqual(EMPTY_STORAGE);
    expect(peer.navigations).toHaveLength(1);
  }
  // Every failed attempt while offline logged one expected browser error.
  expect(acceptOfflineErrors(pageProblems)).toBeGreaterThan(0);
});

test('resumes the host signaling connection without closing the room or promoting the guest', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  await dropSignaling(host);
  await expectResumed(host, 1);
  await expectStatus(host, CONNECTED_STATUS);
  await expectStatus(guest, CONNECTED_STATUS);
  expectOneIdentity(host, 'host', 1);
  expectAuthenticatedResumes(host, guest);
  await expect(room(guest.page).locator('dt', { hasText: 'Your role' }).locator('+ dd')).toHaveText(
    'Guest',
  );
  await expectSingleSession(host.page, 1);
  await expectSingleSession(guest.page, 1);
});

test('resumes both signaling connections and keeps the one data channel', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  const before = (await rtcState(host.page)).sent;
  await Promise.all([dropSignaling(host), dropSignaling(guest)]);
  await expectResumed(host, 1);
  await expectResumed(guest, 1);
  await expectStatus(host, CONNECTED_STATUS);
  await expectStatus(guest, CONNECTED_STATUS);
  expectOneIdentity(host, 'host', 1);
  expectOneIdentity(guest, 'guest', 1);
  expectAuthenticatedResumes(host, guest);
  expectAuthenticatedResumes(guest, host);
  // No extra peer connection, channel, or negotiation on either side.
  expect((await expectSingleSession(host.page, 1)).sent).toStrictEqual(before);
  await expectSingleSession(guest.page, 1);
  expectOneLiveSocket(host);
  expectOneLiveSocket(guest);
});

test('recovers a failed data channel with a fresh peer connection, negotiation, and handshake', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  const first = await rtcState(host.page);
  const [firstNegotiation] = first.sent.map((message) => message.negotiationId);
  const [sessionId] = first.sent.map((message) => message.sessionId);

  await breakDataChannel(guest);
  await expect.poll(async () => (await rtcState(host.page)).peerConnections.length).toBe(2);
  await expectStatus(host, CONNECTED_STATUS);
  await expectStatus(guest, CONNECTED_STATUS);

  for (const peer of [host, guest]) {
    const rtc = await expectSingleSession(peer.page, 2);
    // The failed session stays closed; nothing resurrected it.
    expect(rtc.peerConnections[0]?.connectionState).toBe('closed');
    expect(rtc.channels[0]?.readyState).toBe('closed');
    // Application data crossed the fresh channel both ways, for a fresh
    // negotiation of the same room session.
    const fresh = rtc.received.slice(2);
    expect(fresh.map((message) => message.type).sort()).toStrictEqual(['PEER_HELLO', 'PEER_READY']);
    const negotiation = fresh[0]?.negotiationId;
    expect(negotiation).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(negotiation).not.toBe(firstNegotiation);
    for (const message of [...rtc.sent.slice(2), ...fresh]) {
      expect(message.negotiationId).toBe(negotiation);
      expect(message.sessionId).toBe(sessionId);
    }
    const log = await statusLog(peer);
    expect(log).toContain(RECOVERING);
    expect(log.at(-1)).toBe('Connection restored. Peer data channel is connected.');
    expect(await storageSnapshot(peer.page)).toEqual(EMPTY_STORAGE);
  }
  // The host replaced the negotiation explicitly; the guest never offered.
  expect(frameTypes(host, 0, 'sent')).toContain('RTC_RECOVER');
  expect(frameTypes(guest, 0, 'sent')).not.toContain('RTC_RECOVER');
  expect(frameTypes(guest, 0, 'sent')).not.toContain('RTC_OFFER');
  // Signaling never dropped: no resume took place.
  expect(identities(host).map((entry) => entry.type)).toStrictEqual(['ROOM_CREATED']);
});

test('recovers when signaling is lost and the data channel fails during the outage', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  const [firstNegotiation] = (await rtcState(host.page)).sent.map((m) => m.negotiationId);

  await guest.context.setOffline(true);
  await dropSignaling(guest);
  await expectStatus(guest, SIGNALING_RECONNECTING);
  await breakDataChannel(guest);
  // Both sides know the transport failed; neither can renegotiate yet.
  await expectStatus(guest, 'Reconnecting to signaling…');
  await expectStatus(host, 'The other participant is reconnecting…');
  expect((await rtcState(host.page)).peerConnections).toHaveLength(1);
  expect((await rtcState(guest.page)).peerConnections).toHaveLength(1);

  await guest.context.setOffline(false);
  await expectResumed(guest, 1);
  await expect.poll(async () => (await rtcState(guest.page)).peerConnections.length).toBe(2);
  await expectStatus(guest, CONNECTED_STATUS);
  await expectStatus(host, CONNECTED_STATUS);
  for (const peer of [host, guest]) {
    const rtc = await expectSingleSession(peer.page, 2);
    const fresh = rtc.received.slice(2);
    expect(fresh.map((message) => message.type).sort()).toStrictEqual(['PEER_HELLO', 'PEER_READY']);
    expect(fresh[0]?.negotiationId).not.toBe(firstNegotiation);
  }
  expectOneIdentity(guest, 'guest', 1);
  expectAuthenticatedResumes(guest, host);
  // Nothing from before the outage was replayed on the resumed socket: every
  // negotiation message on it belongs to the fresh negotiation.
  const resumedSocket = guest.sockets.length - 1;
  const replayed = guest.frames.filter(
    (frame) =>
      frame.socket === resumedSocket &&
      frame.direction === 'sent' &&
      firstNegotiation !== undefined &&
      frame.text.includes(firstNegotiation) &&
      !frame.text.includes('"RTC_RECOVERY_REQUEST"'),
  );
  expect(replayed).toStrictEqual([]);
  expect(acceptOfflineErrors(pageProblems)).toBeGreaterThan(0);
});

test('survives ten consecutive signaling reconnects in one room', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  const before = await rtcState(guest.page);
  const cycles = 10;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    // Alternate the side that loses its connection.
    const peer = cycle % 2 === 0 ? host : guest;
    const resumes = Math.ceil(cycle / 2);
    await dropSignaling(peer);
    await expectResumed(peer, resumes);
    await expectStatus(host, CONNECTED_STATUS);
    await expectStatus(guest, CONNECTED_STATUS);
  }
  expectOneIdentity(guest, 'guest', cycles / 2);
  expectOneIdentity(host, 'host', cycles / 2);
  expectAuthenticatedResumes(guest, host);
  expectAuthenticatedResumes(host, guest);
  // The same data channel throughout, and one live socket per side.
  expect((await expectSingleSession(guest.page, 1)).received).toStrictEqual(before.received);
  await expectSingleSession(host.page, 1);
  expectOneLiveSocket(host);
  expectOneLiveSocket(guest);
  expect(host.sockets).toHaveLength(cycles / 2 + 1);
  expect(guest.sockets).toHaveLength(cycles / 2 + 1);
  await expect(room(host.page).getByRole('button', { name: 'Leave room' })).toBeVisible();
});

test('recovers the data channel up to the negotiation bound, then stops safely', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await connectedPair(browser, baseURL, pageProblems);
  const negotiations = new Set((await rtcState(host.page)).sent.map((m) => m.negotiationId));
  // The first negotiation plus three recoveries.
  for (let recovery = 1; recovery <= 3; recovery += 1) {
    await breakDataChannel(recovery % 2 === 0 ? host : guest);
    await expect
      .poll(async () => (await rtcState(host.page)).peerConnections.length)
      .toBe(recovery + 1);
    await expectStatus(host, CONNECTED_STATUS);
    await expectStatus(guest, CONNECTED_STATUS);
    const rtc = await expectSingleSession(host.page, recovery + 1);
    for (const message of rtc.sent) negotiations.add(message.negotiationId);
  }
  expect(negotiations.size).toBe(4);

  await breakDataChannel(guest);
  await expectStatus(host, 'The peer connection to the guest could not be recovered.');
  await expectStatus(guest, 'The peer connection to the host could not be recovered.');
  await expect(room(guest.page).getByRole('alert')).toContainText(
    'Driftless stopped trying to recover it.',
  );
  // No fifth negotiation, and nothing keeps trying.
  await host.page.waitForTimeout(1000);
  expect((await rtcState(host.page)).peerConnections).toHaveLength(4);
  expect((await rtcState(guest.page)).peerConnections).toHaveLength(4);
  // Leaving still works from the failed state.
  await room(guest.page).getByRole('button', { name: 'Leave room' }).click();
  await expectStatus(guest, 'You left the room. You are not in a room.');
  await expectStatus(host, 'The guest left. Room created. Waiting for a guest to join.');
});

const LEAVING = 'Leaving the room…';
const LEFT = 'You left the room. You are not in a room.';

/** The terminal-leave socket resumed only to send ROOM_LEAVE, without the secret. */
function expectTerminalLeave(peer: Peer): void {
  const last = peer.sockets.length - 1;
  expect(frameTypes(peer, last, 'sent')).toStrictEqual([
    'SESSION_RESUME_BEGIN',
    'SESSION_RESUME_PROVE',
    'ROOM_LEAVE',
  ]);
  // The other participant may already have relayed something to the resumed
  // membership before the leave took effect, such as a recovery request; it
  // is ignored, and nothing but ROOM_LEAVE was ever sent in reply.
  const received = frameTypes(peer, last, 'received');
  expect(received.slice(0, 2)).toStrictEqual(['SESSION_RESUME_CHALLENGE', 'SESSION_RESUMED']);
  expect(received.at(-1)).toBe('ROOM_LEFT');
  for (const type of received.slice(2, -1)) {
    expect(['RTC_RECOVERY_REQUEST', 'ROOM_PARTICIPANT_CONNECTION']).toContain(type);
  }
  expect(framesContain(peer, resumeSecretOf(peer))).toBe(false);
  expect(peer.sockets.every((socket) => socket.isClosed())).toBe(true);
}

/** What the page shows and stores after leaving: nothing of the room. */
async function expectNothingLeft(peer: Peer): Promise<void> {
  const secret = resumeSecretOf(peer);
  expect((await peer.page.content()).includes(secret)).toBe(false);
  expect(peer.page.url().includes(secret)).toBe(false);
  expect(await storageSnapshot(peer.page)).toEqual(EMPTY_STORAGE);
  expect(peer.navigations).toHaveLength(1);
  const rtc = await rtcState(peer.page);
  expect(rtc.peerConnections.map((connection) => connection.connectionState)).toStrictEqual([
    'closed',
  ]);
  expect(rtc.mediaCalls).toStrictEqual([]);
}

test('a guest that leaves while reconnecting leaves the room for the service too', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest, roomId, inviteSecret } = await connectedPair(browser, baseURL, pageProblems);
  await guest.context.setOffline(true);
  await dropSignaling(guest);
  await expectStatus(guest, SIGNALING_RECONNECTING);
  await expectStatus(host, PEER_RECONNECTING);

  await room(guest.page).getByRole('button', { name: 'Leave room' }).click();
  // The peer connection closes at once; the room controls are gone.
  await expectStatus(guest, LEAVING);
  expect((await rtcState(guest.page)).peerConnections[0]?.connectionState).toBe('closed');
  await expect(room(guest.page).getByRole('button', { name: 'Leave room' })).toHaveCount(0);

  await guest.context.setOffline(false);
  await expectStatus(guest, LEFT);
  // The service ended the membership at once, as an intentional leave.
  await expectStatus(host, `The guest left. ${WAITING}`);
  expectTerminalLeave(guest);
  await expectNothingLeft(guest);
  const log = await statusLog(guest);
  expect(log.slice(log.indexOf(LEAVING))).toStrictEqual([LEAVING, LEFT]);

  // The slot is free: a new guest joins with the same invite and connects.
  const next = await openPeer(browser, baseURL, pageProblems);
  await join(next, roomId, inviteSecret);
  await expectStatus(next, CONNECTED_STATUS);
  await expectStatus(host, CONNECTED_STATUS);
  expect(acceptOfflineErrors(pageProblems)).toBeGreaterThan(0);
});

test('a host that leaves while reconnecting closes the room and invalidates the invite', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest, roomId, inviteSecret } = await connectedPair(browser, baseURL, pageProblems);
  await host.context.setOffline(true);
  await dropSignaling(host);
  await expectStatus(host, SIGNALING_RECONNECTING);
  await expectStatus(guest, PEER_RECONNECTING);

  await room(host.page).getByRole('button', { name: 'Leave room' }).click();
  await expectStatus(host, LEAVING);
  expect((await rtcState(host.page)).peerConnections[0]?.connectionState).toBe('closed');

  await host.context.setOffline(false);
  await expectStatus(host, LEFT);
  await expectStatus(guest, 'The host closed the room. You are not in a room.');
  // The guest is not promoted.
  await expect(room(guest.page).getByRole('button', { name: 'Create room' })).toBeVisible();
  expectTerminalLeave(host);
  await expectNothingLeft(host);

  // The invite no longer admits anyone.
  const late = await openPeer(browser, baseURL, pageProblems);
  await join(late, roomId, inviteSecret);
  await expect(room(late.page).getByRole('alert')).toHaveText(
    'That room is not available. Check the room ID and invite secret, or ask the host for a new invite.',
  );
  expect(acceptOfflineErrors(pageProblems)).toBeGreaterThan(0);
});
