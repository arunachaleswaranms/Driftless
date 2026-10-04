import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  WebSocket as PageSocket,
} from '@playwright/test';
import { expect, watchPage } from './support.ts';

// Shared helpers of the room browser tests. AUTOMATED SAME-HOST DEVELOPMENT
// BROWSER EVIDENCE only: every peer is a separate browser context in one
// browser on one machine, with a local signaling service and no ICE server.

export const CONNECTED = 'Peer data channel is connected.';
export const WAITING = 'Room created. Waiting for a guest to join.';
// Connection setup on a loaded development machine can take a few seconds;
// this bound keeps a hung negotiation from passing silently.
export const CONNECT_TIMEOUT_MS = 20_000;

/** Type, session, and negotiation of one data-channel message; no other content. */
export interface PeerMessageSummary {
  type: string;
  sessionId: string;
  negotiationId: string;
}

export interface RtcProbe {
  peerConnections: RTCPeerConnection[];
  channels: RTCDataChannel[];
  /** Every WebSocket the page created, in order. */
  sockets: WebSocket[];
  /** Each data-channel message, as sent and received. */
  sent: PeerMessageSummary[];
  received: PeerMessageSummary[];
  /** Any call that would capture or add media. */
  mediaCalls: string[];
  /** Directives of any Content Security Policy violation. */
  cspViolations: string[];
  /** Every distinct text the room status line showed, in order. */
  statusLog: string[];
  /** getStats() calls the application made, per peer connection, by index. */
  statsCalls: number[];
  controlSends: { kind: string; text: string; bytes: number }[];
  slices: { start: number; end: number; size: number }[];
  wholeFileReads: number;
}

declare global {
  interface Window {
    rtcProbe: RtcProbe;
  }
}

// Observes the page's WebRTC objects without changing their behavior, and
// records any media-capture call. Installed before the application loads.
export function installRtcProbe() {
  const probe: RtcProbe = {
    peerConnections: [],
    channels: [],
    sockets: [],
    statusLog: [],
    sent: [],
    received: [],
    mediaCalls: [],
    cspViolations: [],
    statsCalls: [],
    controlSends: [],
    slices: [],
    wholeFileReads: 0,
  };
  window.rtcProbe = probe;
  document.addEventListener('securitypolicyviolation', (event) => {
    probe.cspViolations.push(event.effectiveDirective);
  });

  const summarize = (data: unknown) => {
    if (typeof data !== 'string') return { type: 'binary', sessionId: '', negotiationId: '' };
    const message = JSON.parse(data) as {
      type: string;
      payload: { sessionId: string; negotiationId: string };
    };
    return {
      type: message.type,
      sessionId: message.payload.sessionId,
      negotiationId: message.payload.negotiationId,
    };
  };
  const track = (channel: RTCDataChannel) => {
    probe.channels.push(channel);
    channel.addEventListener('message', (event: MessageEvent) => {
      probe.received.push(summarize(event.data));
    });
  };

  const Original = window.RTCPeerConnection;
  class ObservedPeerConnection extends Original {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      probe.peerConnections.push(this);
      probe.statsCalls.push(0);
      this.addEventListener('datachannel', (event) => {
        track(event.channel);
      });
    }
    // Counted, then passed through unchanged.
    override getStats(selector?: MediaStreamTrack | null): Promise<RTCStatsReport> {
      const index = probe.peerConnections.indexOf(this);
      probe.statsCalls[index] = (probe.statsCalls[index] ?? 0) + 1;
      return super.getStats(selector);
    }
    override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, init);
      track(channel);
      return channel;
    }
    override addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
      probe.mediaCalls.push('addTrack');
      return super.addTrack(track, ...streams);
    }
    override addTransceiver(
      trackOrKind: MediaStreamTrack | string,
      init?: RTCRtpTransceiverInit,
    ): RTCRtpTransceiver {
      probe.mediaCalls.push('addTransceiver');
      return super.addTransceiver(trackOrKind, init);
    }
  }
  window.RTCPeerConnection = ObservedPeerConnection;

  // Records each status-line text the page commits, so transient states can
  // be checked without racing them.
  const watchStatus = () => {
    const record = () => {
      const text = document.querySelector('section.room [role="status"]')?.textContent;
      if (text !== undefined && probe.statusLog.at(-1) !== text) {
        probe.statusLog.push(text);
      }
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    record();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchStatus);
  else watchStatus();

  // Records the page's signaling sockets, unchanged, so a test can close the
  // real socket the application is using.
  const OriginalSocket = window.WebSocket;
  class ObservedSocket extends OriginalSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      probe.sockets.push(this);
    }
  }
  window.WebSocket = ObservedSocket;

  const send = Reflect.get(RTCDataChannel.prototype, 'send') as (data: unknown) => void;
  Reflect.set(RTCDataChannel.prototype, 'send', function (this: RTCDataChannel, data: unknown) {
    probe.controlSends.push({
      kind: typeof data,
      text: typeof data === 'string' ? data : '',
      bytes: typeof data === 'string' ? new TextEncoder().encode(data).byteLength : -1,
    });
    probe.sent.push(summarize(data));
    Reflect.apply(send, this, [data]);
  });
  const slice = Reflect.get(File.prototype, 'slice');
  File.prototype.slice = function (this: File, start = 0, end = this.size, contentType = '') {
    probe.slices.push({ start, end, size: this.size });
    return slice.call(this, start, end, contentType);
  };
  const readFile = Reflect.get(File.prototype, 'arrayBuffer');
  File.prototype.arrayBuffer = function () {
    probe.wholeFileReads++;
    return readFile.call(this);
  };
  for (const name of ['getUserMedia', 'getDisplayMedia'] as const) {
    const original = Reflect.get(MediaDevices.prototype, name) as (...args: unknown[]) => unknown;
    Reflect.set(MediaDevices.prototype, name, function (this: MediaDevices, ...args: unknown[]) {
      probe.mediaCalls.push(name);
      return Reflect.apply(original, this, args);
    });
  }
}

/** One signaling frame, kept in the test process only and never printed. */
export interface SignalingFrame {
  readonly socket: number;
  readonly direction: 'sent' | 'received';
  readonly text: string;
}

export interface Peer {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly sockets: PageSocket[];
  readonly frames: SignalingFrame[];
  readonly requests: { method: string; url: string }[];
  /** Every URL the main frame navigated to. */
  readonly navigations: string[];
}

const contexts: BrowserContext[] = [];

export async function openPeer(
  browser: Browser,
  baseURL: string | undefined,
  problems: string[],
): Promise<Peer> {
  // Each peer is an independent context: no shared storage or session.
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  contexts.push(context);
  const page = await context.newPage();
  watchPage(page, baseURL, problems);
  const sockets: PageSocket[] = [];
  const frames: SignalingFrame[] = [];
  const requests: { method: string; url: string }[] = [];
  const navigations: string[] = [];
  page.on('websocket', (socket) => {
    const index = sockets.push(socket) - 1;
    socket.on('framesent', ({ payload }) => {
      frames.push({ socket: index, direction: 'sent', text: String(payload) });
    });
    socket.on('framereceived', ({ payload }) => {
      frames.push({ socket: index, direction: 'received', text: String(payload) });
    });
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  page.on('request', (request) => {
    requests.push({ method: request.method(), url: request.url() });
  });
  await page.addInitScript(installRtcProbe);
  await page.goto('/');
  return { context, page, sockets, frames, requests, navigations };
}

/** Closes every context opened by `openPeer`; call from `test.afterEach`. */
export async function closePeers(): Promise<void> {
  for (const context of contexts.splice(0)) await context.close();
}

export function room(page: Page): Locator {
  return page.getByRole('region', { name: 'Room' });
}

export function status(page: Page): Locator {
  return room(page).locator('.room-status');
}

export function invite(page: Page): Locator {
  return room(page).getByRole('group', { name: 'Invite' });
}

export function inviteValue(page: Page, term: string): Locator {
  return invite(page).locator('dt', { hasText: term }).locator('+ dd code');
}

export async function createRoom(host: Peer): Promise<{ roomId: string; inviteSecret: string }> {
  await room(host.page).getByRole('button', { name: 'Create room' }).click();
  await expect(status(host.page)).toHaveText(WAITING);
  const roomId = (await inviteValue(host.page, 'Room ID').textContent()) ?? '';
  // The secret is masked until the host reveals it.
  await expect(inviteValue(host.page, 'Invite secret')).toHaveText(/^•+Hidden$/);
  const reveal = invite(host.page).getByRole('button', { name: 'Show invite secret' });
  await reveal.click();
  await expect(reveal).toHaveAttribute('aria-pressed', 'true');
  const inviteSecret = (await inviteValue(host.page, 'Invite secret').textContent()) ?? '';
  await reveal.click();
  await expect(inviteValue(host.page, 'Invite secret')).toHaveText(/^•+Hidden$/);
  expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(inviteSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { roomId, inviteSecret };
}

export async function join(guest: Peer, roomId: string, inviteSecret: string): Promise<void> {
  const page = guest.page;
  await room(page).getByLabel('Room ID').fill(roomId);
  await room(page).getByLabel('Invite secret').fill(inviteSecret);
  await room(page).getByRole('button', { name: 'Join room' }).click();
}

export async function expectConnected(...peers: Peer[]): Promise<void> {
  for (const peer of peers) {
    await expect(status(peer.page)).toHaveText(CONNECTED, { timeout: CONNECT_TIMEOUT_MS });
  }
}

/** What the page's WebRTC objects report, without candidate or SDP text. */
export function rtcState(page: Page) {
  return page.evaluate(() => {
    const probe = window.rtcProbe;
    return {
      peerConnections: probe.peerConnections.map((connection) => ({
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        signalingState: connection.signalingState,
        senders: connection.getSenders().length,
        receivers: connection.getReceivers().length,
        transceivers: connection.getTransceivers().length,
      })),
      channels: probe.channels.map((channel) => ({
        label: channel.label,
        ordered: channel.ordered,
        maxRetransmits: channel.maxRetransmits,
        maxPacketLifeTime: channel.maxPacketLifeTime,
        protocol: channel.protocol,
        negotiated: channel.negotiated,
        readyState: channel.readyState,
      })),
      sent: probe.sent,
      received: probe.received,
      mediaCalls: probe.mediaCalls,
      cspViolations: probe.cspViolations,
    };
  });
}

export async function storageSnapshot(page: Page) {
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

export const EMPTY_STORAGE = {
  caches: [],
  databases: [],
  opfsEntries: [],
  localStorage: 0,
  sessionStorage: 0,
};

/** Text that must never appear on the page: raw SDP and ICE material. */
export const SDP_OR_ICE =
  /candidate:|a=fingerprint|ice-ufrag|ice-pwd|\btyp (host|srflx|relay)\b|\.local\b/;

/** Signaling message types per socket and direction; types only, no content. */
export function frameTypes(peer: Peer, socket: number, direction: 'sent' | 'received'): string[] {
  return peer.frames
    .filter((frame) => frame.socket === socket && frame.direction === direction)
    .map((frame) => (JSON.parse(frame.text) as { type: string }).type);
}

/** The identity the service assigned or restored, from its own messages. */
export function identities(
  peer: Peer,
): { type: string; sessionId: string; participantId: string; role: string }[] {
  return peer.frames.flatMap((frame) => {
    if (frame.direction !== 'received') return [];
    const message = JSON.parse(frame.text) as {
      type: string;
      payload: { sessionId?: string; participantId?: string; role?: string };
    };
    if (!['ROOM_CREATED', 'ROOM_JOINED', 'SESSION_RESUMED'].includes(message.type)) return [];
    const { sessionId = '', participantId = '', role = '' } = message.payload;
    return [{ type: message.type, sessionId, participantId, role }];
  });
}

/**
 * Whether any signaling frame after the first admission contains `value`.
 * Compared as a boolean so a secret never reaches a test report.
 */
export function framesContain(peer: Peer, value: string, after = 1): boolean {
  const first = peer.frames.findIndex(
    (frame) =>
      frame.direction === 'received' &&
      (frame.text.includes('"ROOM_CREATED"') || frame.text.includes('"ROOM_JOINED"')),
  );
  return peer.frames.slice(first + after).some((frame) => frame.text.includes(value));
}

/** The resume secret the service gave this peer, for boolean checks only. */
export function resumeSecretOf(peer: Peer): string {
  for (const frame of peer.frames) {
    const message = JSON.parse(frame.text) as { type: string; payload: { resumeSecret?: string } };
    if (message.payload.resumeSecret !== undefined) return message.payload.resumeSecret;
  }
  throw new Error('no resume secret was received');
}

/**
 * Closes the page's current signaling WebSocket from the browser side with an
 * application close code, as a lost connection rather than an intentional
 * leave. It is the application's real socket; nothing is mocked.
 */
export async function dropSignaling(peer: Peer): Promise<void> {
  await peer.page.evaluate(() => {
    const socket = window.rtcProbe.sockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    socket.close(4000, 'test: connection lost');
  });
}

/** Closes the page's current data channel, which fails the peer session on both sides. */
export async function breakDataChannel(peer: Peer): Promise<void> {
  await peer.page.evaluate(() => {
    const channel = window.rtcProbe.channels.at(-1);
    if (channel === undefined) throw new Error('no channel');
    channel.close();
  });
}

/** A browser console error that Chromium logs for a refused WebSocket while offline. */
export const OFFLINE_SOCKET_ERROR =
  /^console error: WebSocket connection to 'ws:\/\/localhost:4173\/v1\/signaling' failed: Error in connection establishment: net::ERR_INTERNET_DISCONNECTED$/;

/** Ends with the connected status, with or without a restore notice. */
export const CONNECTED_STATUS = /^(Connection restored\. )?Peer data channel is connected\.$/;

/** Every distinct status-line text the page has shown. */
export function statusLog(peer: Peer): Promise<string[]> {
  return peer.page.evaluate(() => [...window.rtcProbe.statusLog]);
}

/** The page's connection diagnostics section, opened. */
export async function openDiagnostics(page: Page): Promise<Locator> {
  const section = room(page).locator('details', { hasText: 'Connection diagnostics' });
  if ((await section.getAttribute('open')) === null) {
    await section.locator('summary').click();
  }
  await expect(section).toHaveAttribute('open', '');
  return section;
}

/** One labelled value of the diagnostics section. */
export function diagnosticsFact(section: Locator, label: string): Locator {
  return section.locator(`dt:text-is("${label}") + dd`);
}

/**
 * The browser's own report of the selected pair of the page's latest peer
 * connection, read independently of the application: candidate types and
 * protocol only, never addresses. Does not count as an application call.
 */
export function selectedPairTypes(page: Page) {
  return page.evaluate(async () => {
    const probe = window.rtcProbe;
    const connection = probe.peerConnections.at(-1);
    if (connection === undefined) throw new Error('no peer connection');
    const index = probe.peerConnections.length - 1;
    const before = probe.statsCalls[index] ?? 0;
    const report = await connection.getStats();
    probe.statsCalls[index] = before;
    const all = new Map<string, Record<string, unknown>>();
    report.forEach((value: Record<string, unknown>) => {
      all.set(String(value.id), value);
    });
    const pairIds = [...all.values()]
      .filter((value) => value.type === 'transport')
      .map((value) => value.selectedCandidatePairId);
    const pair = all.get(String(pairIds[0]));
    const local = all.get(String(pair?.localCandidateId));
    const remote = all.get(String(pair?.remoteCandidateId));
    const responses = pair?.responsesReceived;
    return {
      transports: pairIds.length,
      // Chrome reports the working pair as in-progress during a re-check.
      pairSucceeded:
        pair?.state === 'succeeded' ||
        (pair?.state === 'in-progress' && typeof responses === 'number' && responses > 0),
      local: local?.candidateType,
      remote: remote?.candidateType,
      protocol: local?.protocol,
    };
  });
}

/** IPv4 or IPv6 literals, and mDNS host names. */
export const ADDRESS_LIKE =
  /\b\d{1,3}(\.\d{1,3}){3}\b|\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b|\.local\b/i;
