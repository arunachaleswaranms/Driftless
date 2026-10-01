import {
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  PEER_CONTROL_CHANNEL_LABEL,
  type InviteSecret,
  type NegotiationId,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeSecret,
  type RoomId,
  type RtcIceServer,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  FakeDataChannel,
  FakePeerConnection,
  FakeTimers,
  FakeWebSocket,
  STATS_ADDRESSES,
  fakeProver,
  flush,
  peerMessage,
  remoteCandidate,
  statsReport,
} from '../../test/room.ts';
import { diagnosticsText } from './diagnostics.ts';
import type { IceTransportPolicyResult } from './iceServers.ts';
import { HOST_RECOVERY_DELAY_MS } from './reconnectSchedule.ts';
import { RoomController, type RoomState } from './roomController.ts';
import { RTC_CONFIG_REFRESH_MARGIN_MS, RTC_CONFIG_WAIT_MS } from './rtcConfig.ts';

// AUTOMATED UNIT EVIDENCE with deterministic fakes: the service-provided ICE
// configuration (Phase 2D) and connection diagnostics. No real socket, peer
// connection, TURN server, or timer is involved.

const ROOM_ID = `${'R'.repeat(21)}Q` as RoomId;
const SECRET = `${'S'.repeat(42)}E` as InviteSecret;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;
const SESSION_ID = 'Q'.repeat(27) as SessionId;
const HOST_RESUME = 'h'.repeat(44) as ResumeSecret;
const GUEST_RESUME = 'g'.repeat(44) as ResumeSecret;

const TURN_USERNAME = '1760003600:turnUSERmark0001';
const TURN_CREDENTIAL = 'turnCREDENTIALmark/0000000000=';
const STUN_SERVER: RtcIceServer = {
  urls: ['stun:stun.example.org:3478'],
  username: null,
  credential: null,
};
const TURN_SERVER: RtcIceServer = {
  urls: ['turn:turn.example.org:3478?transport=udp'],
  username: TURN_USERNAME,
  credential: TURN_CREDENTIAL,
};
const BUILD_STUN = { urls: ['stun:build.example.org'] };

function idOf(index: number): NegotiationId {
  return String(index).padStart(24, 'N') as NegotiationId;
}

function setup(
  options: {
    source?: 'service' | 'none';
    policy?: IceTransportPolicyResult;
  } = {},
) {
  const sockets: FakeWebSocket[] = [];
  const connections: FakePeerConnection[] = [];
  const timers = new FakeTimers();
  let negotiations = 0;
  const controller = new RoomController({
    signalingUrl: { ok: true, url: 'ws://localhost:4173/v1/signaling' },
    iceServers: { ok: true, iceServers: [BUILD_STUN] },
    ...(options.policy === undefined ? {} : { iceTransportPolicy: options.policy }),
    rtcConfigSource: options.source ?? 'service',
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    createPeerConnection: (configuration) => {
      const connection = new FakePeerConnection(configuration);
      connections.push(connection);
      return connection.asPeerConnection();
    },
    createNegotiationId: () => {
      negotiations += 1;
      return idOf(negotiations);
    },
    proveResume: fakeProver().prove,
    clock: () => timers.now,
    timers,
  });
  const socket = () => {
    const current = sockets.at(-1);
    if (current === undefined) throw new Error('no socket');
    return current;
  };
  const connection = (index = -1) => {
    const current = connections.at(index);
    if (current === undefined) throw new Error('no connection');
    return current;
  };
  return { controller, sockets, connections, timers, socket, connection };
}

type Harness = ReturnType<typeof setup>;

function inRoom(state: RoomState) {
  if (state.phase !== 'in-room') throw new Error(`expected in-room, got ${state.phase}`);
  return state;
}

/** The service's RTC_CONFIG, valid for `ttlMs` (FakeWebSocket sends sentAt 0). */
function deliverConfig(
  harness: Harness,
  iceServers: readonly RtcIceServer[] = [STUN_SERVER, TURN_SERVER],
  ttlMs = 600_000,
) {
  harness.socket().deliver({
    type: 'RTC_CONFIG',
    payload: { expiresAt: ttlMs, iceServers },
  });
}

async function hostInRoom(harness: Harness = setup()) {
  harness.controller.createRoom();
  harness.socket().open();
  await flush();
  harness.socket().deliver({
    type: 'ROOM_CREATED',
    payload: {
      roomId: ROOM_ID,
      sessionId: SESSION_ID,
      inviteSecret: SECRET,
      resumeSecret: HOST_RESUME,
      participantId: HOST_ID,
      role: 'host',
      expiresAt: 1,
    },
  });
  return harness;
}

async function guestJoins(harness: Harness) {
  harness.socket().deliver({
    type: 'ROOM_PARTICIPANT_JOINED',
    payload: { participant: { participantId: GUEST_ID, role: 'guest' } },
  });
  await flush();
}

async function guestInRoom(harness: Harness = setup()) {
  harness.controller.joinRoom(ROOM_ID, SECRET);
  harness.socket().open();
  await flush();
  harness.socket().deliver({
    type: 'ROOM_JOINED',
    payload: {
      roomId: ROOM_ID,
      sessionId: SESSION_ID,
      resumeSecret: GUEST_RESUME,
      participantId: GUEST_ID,
      role: 'guest',
      peer: { participantId: HOST_ID, role: 'host' },
      expiresAt: 1,
    },
  });
  return harness;
}

/** Drives the host's current session to connected. */
async function connectHost(harness: Harness) {
  const pc = harness.connection();
  await pc.settle('createOffer');
  await pc.settle('setLocalDescription');
  const sent = harness.socket().sent.at(-1);
  if (sent?.type !== 'RTC_OFFER' && sent?.type !== 'RTC_RECOVER') throw new Error('no offer');
  const { negotiationId } = sent.payload;
  harness.socket().deliver({ type: 'RTC_ANSWER', payload: { negotiationId, sdp: 'v=0\r\n' } });
  await flush();
  await pc.settle('setRemoteDescription');
  const channel = pc.channels[0];
  if (channel === undefined) throw new Error('no channel');
  pc.iceConnectionState = 'connected';
  pc.connectionState = 'connected';
  channel.open();
  const fromGuest = {
    sessionId: SESSION_ID,
    negotiationId,
    senderId: GUEST_ID,
    recipientId: HOST_ID,
  };
  channel.receive(peerMessage('PEER_HELLO', fromGuest, 0));
  channel.receive(peerMessage('PEER_READY', fromGuest, 1));
  await flush();
  return { pc, channel, negotiationId };
}

/** Drives the guest's current session to connected. */
async function connectGuest(harness: Harness, negotiationId: NegotiationId) {
  const pc = harness.connection();
  await pc.settle('setRemoteDescription');
  await pc.settle('createAnswer');
  await pc.settle('setLocalDescription');
  const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
  pc.announceChannel(channel);
  pc.iceConnectionState = 'connected';
  pc.connectionState = 'connected';
  channel.open();
  const fromHost = {
    sessionId: SESSION_ID,
    negotiationId,
    senderId: HOST_ID,
    recipientId: GUEST_ID,
  };
  channel.receive(peerMessage('PEER_HELLO', fromHost, 0));
  channel.receive(peerMessage('PEER_READY', fromHost, 1));
  await flush();
  return { pc, channel };
}

/** Everything a user or a log could see: room state, diagnostics, and the export. */
function visible(harness: Harness): string {
  const state = harness.controller.getState();
  const diagnostics = harness.controller.getDiagnostics();
  return [
    JSON.stringify(state),
    JSON.stringify(diagnostics),
    diagnosticsText(diagnostics, { role: 'host', signaling: 'connected', build: 'test' }),
  ].join('\n');
}

describe('service ICE configuration', () => {
  it('asks only after admission, never while opening or resuming', async () => {
    const harness = setup();
    harness.controller.createRoom();
    harness.socket().open();
    await flush();
    expect(harness.socket().sent.map((m) => m.type)).toStrictEqual(['ROOM_CREATE']);
    harness.socket().deliver({
      type: 'ROOM_CREATED',
      payload: {
        roomId: ROOM_ID,
        sessionId: SESSION_ID,
        inviteSecret: SECRET,
        resumeSecret: HOST_RESUME,
        participantId: HOST_ID,
        role: 'host',
        expiresAt: 1,
      },
    });
    expect(harness.socket().sent.map((m) => m.type)).toStrictEqual([
      'ROOM_CREATE',
      'RTC_CONFIG_REQUEST',
    ]);
    deliverConfig(harness);

    // A resuming connection asks for nothing until its membership is back.
    harness.socket().drop();
    await harness.timers.advance(0);
    const resuming = harness.socket();
    resuming.open();
    await flush();
    resuming.deliver({
      type: 'SESSION_RESUME_CHALLENGE',
      payload: { challenge: 'c'.repeat(32) as ResumeChallenge },
    });
    await flush();
    expect(resuming.sent.map((m) => m.type)).toStrictEqual([
      'SESSION_RESUME_BEGIN',
      'SESSION_RESUME_PROVE',
    ]);
    resuming.deliver({
      type: 'SESSION_RESUMED',
      payload: {
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        participantId: HOST_ID,
        role: 'host',
        expiresAt: 1,
        peer: null,
        activeNegotiationId: null,
        negotiationCount: 0,
      },
    });
    await flush();
    // The held configuration is still usable, so the resumed connection does not ask.
    expect(resuming.sent.map((m) => m.type)).toStrictEqual([
      'SESSION_RESUME_BEGIN',
      'SESSION_RESUME_PROVE',
    ]);
    await guestJoins(harness);
    expect(harness.connections).toHaveLength(1);
  });

  it('host: offers only once the configuration arrives, with build STUN, service STUN, and TURN', async () => {
    const harness = await hostInRoom();
    await guestJoins(harness);
    expect(harness.connections).toHaveLength(0);
    deliverConfig(harness);
    await flush();
    expect(harness.connection().configuration).toStrictEqual({
      iceServers: [
        BUILD_STUN,
        { urls: STUN_SERVER.urls },
        { urls: TURN_SERVER.urls, username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      ],
    });
    expect(harness.socket().sentOfType('RTC_CONFIG_REQUEST')).toHaveLength(1);
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('host: a configuration that arrived before the guest is used at once', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness);
    await guestJoins(harness);
    expect(harness.connections).toHaveLength(1);
    expect(harness.socket().sentOfType('RTC_CONFIG_REQUEST')).toHaveLength(1);
  });

  it('guest: holds the offer and early candidates until the configuration arrives', async () => {
    const harness = await guestInRoom();
    const negotiationId = idOf(1);
    harness.socket().deliver({ type: 'RTC_OFFER', payload: { negotiationId, sdp: 'v=0\r\n' } });
    harness.socket().deliver({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId, candidate: remoteCandidate(1) },
    });
    await flush();
    expect(harness.connections).toHaveLength(0);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('negotiating');
    deliverConfig(harness);
    await flush();
    const pc = harness.connection();
    expect(pc.configuration.iceServers).toHaveLength(3);
    await connectGuest(harness, negotiationId);
    expect(pc.addedCandidates).toStrictEqual([remoteCandidate(1)]);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connected');
    expect(harness.controller.getDiagnostics().turn).toBe('offered');
  });

  it('starts without TURN after the bounded wait, and says so', async () => {
    const harness = await hostInRoom();
    await guestJoins(harness);
    await harness.timers.advance(RTC_CONFIG_WAIT_MS - 1);
    expect(harness.connections).toHaveLength(0);
    await harness.timers.advance(1);
    expect(harness.connection().configuration).toStrictEqual({ iceServers: [BUILD_STUN] });
    harness.connection().stats = statsReport('host', 'host');
    await connectHost(harness);
    expect(harness.controller.getDiagnostics()).toMatchObject({
      turn: 'unavailable',
      path: { classification: 'DIRECT' },
    });
    // A late answer does not disturb the connected session.
    deliverConfig(harness);
    await flush();
    expect(harness.connections).toHaveLength(1);
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('treats a configuration with no lifetime, or too long a lifetime, as unavailable', async () => {
    for (const ttl of [0, 86_400_001]) {
      const harness = await hostInRoom();
      deliverConfig(harness, [TURN_SERVER], ttl);
      await guestJoins(harness);
      // Unusable: a fresh request goes out and the wait starts.
      expect(harness.connections).toHaveLength(0);
      expect(harness.socket().sentOfType('RTC_CONFIG_REQUEST')).toHaveLength(2);
      await harness.timers.advance(RTC_CONFIG_WAIT_MS);
      expect(harness.connection().configuration).toStrictEqual({ iceServers: [BUILD_STUN] });
    }
  });

  it('reports a service without TURN as not configured', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    await guestJoins(harness);
    harness.connection().stats = statsReport('srflx', 'srflx');
    await connectHost(harness);
    expect(harness.connection().configuration).toStrictEqual({ iceServers: [BUILD_STUN] });
    expect(harness.controller.getDiagnostics().turn).toBe('not_configured');
  });

  it('ignores an RTC_CONFIG it did not ask for', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    deliverConfig(harness, [TURN_SERVER]);
    await guestJoins(harness);
    expect(harness.connection().configuration).toStrictEqual({ iceServers: [BUILD_STUN] });
  });

  it('fetches a fresh credential before a recovery when the held one is about to expire', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, [TURN_SERVER], 600_000);
    await guestJoins(harness);
    const first = await connectHost(harness);
    await harness.timers.advance(600_000 - RTC_CONFIG_REFRESH_MARGIN_MS);
    first.pc.setConnectionState('failed');
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
    expect(harness.connections).toHaveLength(1);
    expect(harness.socket().sentOfType('RTC_CONFIG_REQUEST')).toHaveLength(2);
    const fresh = { ...TURN_SERVER, username: '1760009999:turnUSERmark0001', credential: 'fresh=' };
    harness.socket().deliver({
      type: 'RTC_CONFIG',
      payload: { expiresAt: 600_000, iceServers: [fresh] },
    });
    await flush();
    expect(harness.connection().configuration.iceServers?.at(-1)).toStrictEqual({
      urls: fresh.urls,
      username: fresh.username,
      credential: 'fresh=',
    });
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    expect(harness.socket().sent.at(-1)?.type).toBe('RTC_RECOVER');
  });

  it('forgets the configuration with the membership', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness);
    harness.controller.leaveRoom();
    harness.socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    await hostInRoom(harness);
    await guestJoins(harness);
    // The new room asks again and does not reuse the old credential.
    expect(harness.connections).toHaveLength(0);
    await harness.timers.advance(RTC_CONFIG_WAIT_MS);
    expect(JSON.stringify(harness.connection().configuration)).not.toContain(TURN_CREDENTIAL);
  });

  it('drops a pending start and its timer when signaling is lost', async () => {
    const harness = await hostInRoom();
    await guestJoins(harness);
    expect(harness.timers.pendingCount).toBe(1);
    harness.controller.shutdown();
    expect(harness.timers.pendingCount).toBe(0);
    expect(harness.connections).toHaveLength(0);
  });

  it('keeps the TURN credential out of the room state, diagnostics, and export', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness);
    await guestJoins(harness);
    harness.connection().stats = statsReport('relay', 'srflx', { relayProtocol: 'udp' });
    await connectHost(harness);
    const text = visible(harness);
    for (const value of [TURN_USERNAME, TURN_CREDENTIAL, 'turn.example.org', ...STATS_ADDRESSES]) {
      expect(text).not.toContain(value);
    }
  });

  it('uses only the build-time servers when the source is none', async () => {
    const harness = await hostInRoom(setup({ source: 'none' }));
    expect(harness.socket().sentOfType('RTC_CONFIG_REQUEST')).toHaveLength(0);
    await guestJoins(harness);
    expect(harness.connection().configuration).toStrictEqual({ iceServers: [BUILD_STUN] });
    harness.connection().stats = statsReport('host', 'host');
    await connectHost(harness);
    expect(harness.controller.getDiagnostics().turn).toBe('not_requested');
  });
});

describe('forced relay (qualification builds only)', () => {
  const relay: IceTransportPolicyResult = { ok: true, policy: 'relay' };

  it('passes the relay policy to every peer connection with TURN', async () => {
    const harness = await hostInRoom(setup({ policy: relay }));
    deliverConfig(harness);
    await guestJoins(harness);
    expect(harness.connection().configuration).toMatchObject({ iceTransportPolicy: 'relay' });
    harness.connection().stats = statsReport('relay', 'relay', { relayProtocol: 'udp' });
    await connectHost(harness);
    expect(harness.controller.getDiagnostics()).toMatchObject({
      icePolicy: 'relay',
      turn: 'offered',
      path: { classification: 'TURN_RELAY', localCandidateType: 'relay' },
    });
  });

  it('fails cleanly, without a peer connection, when no TURN server is available', async () => {
    const harness = await hostInRoom(setup({ policy: relay }));
    deliverConfig(harness, [STUN_SERVER]);
    await guestJoins(harness);
    expect(harness.connections).toHaveLength(0);
    expect(inRoom(harness.controller.getState()).peer).toMatchObject({
      connection: 'recovering',
      failure: 'relay_unavailable',
    });
    // Bounded like any failure: no offer ever left, and recovery stops at the bound.
    for (let index = 0; index < MAX_NEGOTIATIONS_PER_MEMBERSHIP; index += 1) {
      await harness.timers.advance(HOST_RECOVERY_DELAY_MS + RTC_CONFIG_WAIT_MS);
    }
    expect(harness.connections).toHaveLength(0);
    expect(harness.socket().sentOfType('RTC_OFFER')).toHaveLength(0);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('failed');
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('is refused as configuration unless it is all or relay', () => {
    const harness = setup({ policy: { ok: false, reason: 'invalid_ice_config' } });
    harness.controller.createRoom();
    expect(harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'invalid_ice_config',
    });
    expect(harness.sockets).toHaveLength(0);
  });
});

describe('connection diagnostics', () => {
  it('has nothing to show before a peer connection exists', async () => {
    const harness = await hostInRoom();
    expect(harness.controller.getDiagnostics()).toMatchObject({
      status: 'none',
      path: { classification: 'UNKNOWN' },
      negotiation: null,
      icePolicy: 'all',
    });
    harness.controller.refreshDiagnostics();
    expect(harness.controller.getDiagnostics().status).toBe('none');
  });

  it('collects one snapshot when the session connects, and never polls', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    await guestJoins(harness);
    const pc = harness.connection();
    pc.stats = statsReport('host', 'host');
    expect(pc.getStatsCalls).toBe(0);
    await connectHost(harness);
    expect(pc.getStatsCalls).toBe(1);
    expect(harness.controller.getDiagnostics()).toStrictEqual({
      status: 'ready',
      peerConnection: 'connected',
      iceConnection: 'connected',
      dataChannel: 'open',
      path: {
        classification: 'DIRECT',
        localCandidateType: 'host',
        remoteCandidateType: 'host',
        protocol: 'udp',
        relayProtocol: null,
      },
      negotiation: { count: 1, max: MAX_NEGOTIATIONS_PER_MEMBERSHIP },
      turn: 'not_configured',
      icePolicy: 'all',
      collectedAt: harness.timers.now,
    });
    await harness.timers.advance(3_600_000);
    expect(pc.getStatsCalls).toBe(1);
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('collects again only when asked', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    await guestJoins(harness);
    const pc = harness.connection();
    pc.stats = statsReport('host', 'host');
    await connectHost(harness);
    pc.stats = statsReport('srflx', 'prflx');
    harness.controller.refreshDiagnostics();
    expect(harness.controller.getDiagnostics().status).toBe('collecting');
    await flush();
    expect(pc.getStatsCalls).toBe(2);
    expect(harness.controller.getDiagnostics().path).toMatchObject({
      classification: 'DIRECT',
      localCandidateType: 'srflx',
      remoteCandidateType: 'prflx',
    });
  });

  it('reports UNKNOWN and leaves the room untouched when statistics fail', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    await guestJoins(harness);
    const pc = harness.connection();
    pc.stats = 'reject';
    const sentBefore = harness.socket().sentText.length;
    await connectHost(harness);
    const state = harness.controller.getState();
    expect(harness.controller.getDiagnostics()).toMatchObject({
      status: 'ready',
      path: { classification: 'UNKNOWN', reason: 'no_report' },
    });
    expect(inRoom(state).peer?.connection).toBe('connected');
    expect(pc.closed).toBe(false);
    expect(harness.connections).toHaveLength(1);
    // Nothing was renegotiated or sent because of it.
    await harness.timers.advance(60_000);
    expect(harness.controller.getState()).toBe(state);
    expect(
      harness
        .socket()
        .sent.slice(sentBefore)
        .map((m) => m.type),
    ).toStrictEqual(['RTC_OFFER']);

    // An unfamiliar report shape is also UNKNOWN, not a failure.
    pc.stats = new Map<string, unknown>([['x', { id: 'x', type: 'transport' }]]);
    harness.controller.refreshDiagnostics();
    await flush();
    expect(harness.controller.getDiagnostics().path).toStrictEqual({
      classification: 'UNKNOWN',
      reason: 'no_selected_pair',
    });
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connected');
  });

  it('describes the new connection after recovery, and discards the old one', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness);
    await guestJoins(harness);
    const first = await (async () => {
      harness.connection().stats = statsReport('host', 'host');
      return connectHost(harness);
    })();
    expect(harness.controller.getDiagnostics().path).toMatchObject({ classification: 'DIRECT' });

    // A refresh is still reading the old connection's statistics when it fails.
    first.pc.stats = 'pending';
    harness.controller.refreshDiagnostics();
    first.pc.setConnectionState('failed');
    expect(harness.controller.getDiagnostics()).toMatchObject({
      status: 'none',
      path: { classification: 'UNKNOWN' },
      peerConnection: null,
    });
    await first.pc.resolveStats(statsReport('host', 'host'));
    expect(harness.controller.getDiagnostics().status).toBe('none');

    await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
    const second = harness.connection();
    expect(second).not.toBe(first.pc);
    second.stats = statsReport('relay', 'srflx', { pairId: 'CP-new', relayProtocol: 'tcp' });
    await connectHost(harness);
    expect(second.getStatsCalls).toBe(1);
    // The connect snapshot and the refresh that was discarded; nothing since.
    expect(first.pc.getStatsCalls).toBe(2);
    expect(harness.controller.getDiagnostics()).toMatchObject({
      status: 'ready',
      path: { classification: 'TURN_RELAY', localCandidateType: 'relay', relayProtocol: 'tcp' },
      negotiation: { count: 2, max: MAX_NEGOTIATIONS_PER_MEMBERSHIP },
    });
  });

  it('is cleared when the room ends', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    await guestJoins(harness);
    harness.connection().stats = statsReport('host', 'host');
    await connectHost(harness);
    harness.controller.leaveRoom();
    expect(harness.controller.getDiagnostics()).toMatchObject({
      status: 'none',
      negotiation: null,
      peerConnection: null,
    });
  });

  it('notifies diagnostics subscribers without notifying room-state subscribers', async () => {
    const harness = await hostInRoom();
    deliverConfig(harness, []);
    await guestJoins(harness);
    const pc = harness.connection();
    pc.stats = statsReport('host', 'host');
    await connectHost(harness);
    let roomNotifications = 0;
    let diagnosticsNotifications = 0;
    harness.controller.subscribe(() => (roomNotifications += 1));
    harness.controller.subscribeDiagnostics(() => (diagnosticsNotifications += 1));
    pc.stats = statsReport('srflx', 'srflx');
    harness.controller.refreshDiagnostics();
    await flush();
    expect(diagnosticsNotifications).toBe(2);
    expect(roomNotifications).toBe(0);
  });
});
